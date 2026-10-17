package com.bilimusic.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/**
 * 整个 App 就两样东西：一个全屏 WebView + 一个前台服务。
 *
 * - WebView 加载 B站页面，并注入 `assets/bili-music.js`（和桌面版完全同一个文件）
 * - 前台服务让进程在切后台后不被系统回收，这是"后台播放"能成立的关键
 *
 * 注入时机用 `onPageStarted`（尽早），配合脚本里已有的 `whenDocumentRoot` 兜底，
 * 所以哪怕这会儿 documentElement 还没建出来也不会崩。
 *
 * ★ 千万不要把 `userAgentString = DESKTOP_UA` 那行删掉。
 *   默认 UA 带 `Android ... wv`，B站会把 www.bilibili.com 302 到 m.bilibili.com，
 *   playurl 随之改为返回 mcdn.bilivideo.cn:8082 的 P2P 音频节点，
 *   在模拟器/部分网络下取不到数据，现象是「全部线路失败」。
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var playerScript: String = ""

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        playerScript = try {
            assets.open("bili-music.js").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            Log.e(TAG, "读取播放器脚本失败", e)
            ""
        }

        webView = WebView(this)
        webView.setBackgroundColor(Color.parseColor("#0f1115"))
        // 允许 chrome://inspect 远程调试：模拟器/真机排查「播放失败」时能直接看 console
        WebView.setWebContentsDebuggingEnabled(true)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // 关键：允许脚本自己 play()，否则每次都要先戳一下屏幕
            mediaPlaybackRequiresUserGesture = false
            // B站部分图片还是 http
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT

            // ★ 视口：按设备宽度排版（CSS 像素 = 屏幕宽度）。
            //   开着 useWideViewPort 会把视口撑成 980px 再把整页缩小塞进屏幕，
            //   结果就是我们自己的 UI 也被当成桌面页布局：两栏并排、字小、比例失调。
            useWideViewPort = false
            loadWithOverviewMode = false

            // 禁止一切缩放（双指、双击、按钮）
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
            // ★ 关键：伪装成桌面 Chrome。
            // WebView 默认 UA 带 "Android ... wv"，B站会把 www.bilibili.com 302 到
            // m.bilibili.com；落地页一变，playurl 给出的音频就改走 mcdn.bilivideo.cn:8082
            // 这类 P2P 节点，在模拟器/部分网络下取不到数据（表现为「全部线路失败」）。
            // 换成桌面 UA 后落地页保持 www.bilibili.com，与 Windows 版完全同构。
            userAgentString = DESKTOP_UA
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                // 双保险：万一还是被重定向到移动站，拉回桌面站
                if (view != null && url != null && url.contains("://m.bilibili.com")) {
                    view.loadUrl(START_URL)
                    return
                }
                if (view != null && playerScript.isNotEmpty()) {
                    view.evaluateJavascript(playerScript, null)
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // 兜底校验：早注入没成功就补一次
                view?.evaluateJavascript("!!document.getElementById('bm-root')") { hasUi ->
                    if (hasUi != "true" && playerScript.isNotEmpty()) {
                        view.evaluateJavascript(playerScript, null)
                    }
                }
            }
        }
        webView.webChromeClient = WebChromeClient()

        // ---- JS ↔ Kotlin 桥 ----
        // 脚本 → 原生：BiliMusicAndroid.onState(json)，用来刷新通知栏文字/按钮
        // 原生 → 脚本：PlayerBridge.command() 最终走下面的 evaluateJavascript
        // 只加载 bilibili.com，不对外暴露危险方法，所以 addJavascriptInterface 是可接受的
        webView.addJavascriptInterface(JsBridge(), "BiliMusicAndroid")
        PlayerBridge.sendCommand = { cmd ->
            runOnUiThread {
                try {
                    webView.evaluateJavascript(
                        "window.__bmCmd && window.__bmCmd('" + cmd.replace("'", "\\'") + "')",
                        null
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "向页面发送命令失败：$cmd", e)
                }
            }
        }

        setContentView(webView)
        webView.loadUrl(START_URL)

        startPlaybackService()
        requestNotificationPermission()
    }

    /** Android 13+ 通知默认需运行时授权才能显示（媒体控件通常不受限，但求个稳） */
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
        }
    }

    /**
     * 脚本调用的入口。
     * 注意：这些方法跑在 WebView 的 JS 线程上，不能直接碰 UI。
     */
    private inner class JsBridge {
        @JavascriptInterface
        fun onState(json: String) {
            try {
                val o = JSONObject(json)
                PlayerBridge.report(
                    PlayerState(
                        playing = o.optBoolean("playing", false),
                        title = o.optString("title", ""),
                        author = o.optString("author", ""),
                        cover = o.optString("cover", ""),
                        durationMs = (o.optDouble("duration", 0.0) * 1000).toLong(),
                        positionMs = (o.optDouble("position", 0.0) * 1000).toLong(),
                        hasPrev = o.optBoolean("hasPrev", false),
                        hasNext = o.optBoolean("hasNext", false),
                    )
                )
            } catch (e: Exception) {
                Log.w(TAG, "解析播放状态失败", e)
            }
        }
    }

    private fun startPlaybackService() {
        val intent = Intent(this, PlaybackService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    override fun onDestroy() {
        // 先把桥拆了，之后 WebView 再回调进来就无处可去
        PlayerBridge.sendCommand = null
        try {
            webView.removeJavascriptInterface("BiliMusicAndroid")
        } catch (e: Exception) {
            Log.w(TAG, "移除 JS 接口失败", e)
        }
        webView.destroy()
        super.onDestroy()
    }

    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        // 有历史就走历史，否则退出（避免误触直接关掉音乐）
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    companion object {
        private const val TAG = "BiliMusic"
        private const val START_URL = "https://www.bilibili.com/"
        private const val REQ_NOTIFY = 100

        /** 桌面 Chrome UA。必须用它，否则会被 B站 302 到移动站，连带的音频 CDN 也跟着变。 */
        private const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    }
}
