package com.bilimusic.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * 前台服务 + MediaSession。
 *
 * 它不自己播放音频（音频在 WebView 里），职责有两个：
 *  1. 挂一个前台通知，让进程在切后台时不被系统回收 —— 这是"后台播放"能成立的前提；
 *  2. 维护 MediaSession，把通知栏（连带耳机线控、蓝牙、锁屏）的
 *     播放/暂停/上一曲/下一曲转发给 WebView 里的播放器。
 *
 * 按钮从哪来：
 *  - Android 12 及以下：`Notification.MediaStyle` + addAction 自己画的按钮；
 *  - Android 13 及以上：系统接管成「媒体控件」，按钮由
 *    `PlaybackState` 里的 actions 决定（MediaStyle 的 compactView 会被忽略）。
 *  所以两边都得设，缺一个就会出现"某些机型没按钮"。
 */
class PlaybackService : Service() {

    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        setupSession()

        PlayerBridge.onState = { st -> applyState(st) }

        // Service 可能比页面就绪更晚，先用最近一次状态把通知撑起来
        val st = PlayerBridge.lastState
        startForegroundCompat(buildNotification(st))
        applyState(st)
    }

    override fun onDestroy() {
        PlayerBridge.onState = null
        try {
            session?.isActive = false
            session?.release()
        } catch (e: Exception) {
            Log.w(TAG, "释放 MediaSession 失败", e)
        }
        session = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 通知栏按钮点进来走这里
        when (intent?.action) {
            ACTION_TOGGLE -> PlayerBridge.command("toggle")
            ACTION_PREV -> PlayerBridge.command("prev")
            ACTION_NEXT -> PlayerBridge.command("next")
        }
        return START_STICKY
    }

    /* ---------------- MediaSession ---------------- */

    private fun setupSession() {
        val s = MediaSession(this, "BiliMusic")
        s.setCallback(object : MediaSession.Callback() {
            override fun onPlay() = PlayerBridge.command("play")
            override fun onPause() = PlayerBridge.command("pause")
            override fun onStop() = PlayerBridge.command("pause")
            override fun onSkipToNext() = PlayerBridge.command("next")
            override fun onSkipToPrevious() = PlayerBridge.command("prev")
        })
        s.isActive = true
        session = s
    }

    /** 把 JS 报上来的状态同步到 MediaSession + 通知栏 */
    private fun applyState(st: PlayerState) {
        val s = session ?: return

        var actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP
        // 单视频时不给上一曲/下一曲，系统也就不会画那两个按钮
        if (st.hasPrev) actions = actions or PlaybackState.ACTION_SKIP_TO_PREVIOUS
        if (st.hasNext) actions = actions or PlaybackState.ACTION_SKIP_TO_NEXT

        try {
            s.setPlaybackState(
                PlaybackState.Builder()
                    .setActions(actions)
                    .setState(
                        if (st.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                        st.positionMs,
                        if (st.playing) 1.0f else 0f
                    )
                    .build()
            )
            s.setMetadata(
                MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, st.title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, st.author)
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, st.durationMs)
                    .build()
            )
        } catch (e: Exception) {
            Log.w(TAG, "更新 MediaSession 失败", e)
        }

        updateNotification(st)
    }

    /* ---------------- 通知 ---------------- */

    private fun buildNotification(st: PlayerState): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        builder
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(st.title.ifBlank { "BiliMusic" })
            .setContentText(st.author.ifBlank { "B站纯音频播放器" })
            .setContentIntent(openAppIntent())
            .setOngoing(true)          // 别让用户误划掉，划掉等于关掉后台播放
            .setOnlyAlertOnce(true)    // 进度每几秒更新一次，绝不能重复响铃
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)

        val compact = ArrayList<Int>(3)
        var idx = 0

        if (st.hasPrev) {
            builder.addAction(action(android.R.drawable.ic_media_previous, "上一曲", ACTION_PREV))
            compact.add(idx++)
        }
        builder.addAction(
            action(
                if (st.playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (st.playing) "暂停" else "播放",
                ACTION_TOGGLE
            )
        )
        compact.add(idx++)
        if (st.hasNext) {
            builder.addAction(action(android.R.drawable.ic_media_next, "下一曲", ACTION_NEXT))
            compact.add(idx)
        }

        // MediaStyle 只在 Android 12 及以下真正生效；13+ 由系统按 PlaybackState 重排
        try {
            builder.setStyle(
                Notification.MediaStyle()
                    .setMediaSession(session?.sessionToken)
                    .setShowActionsInCompactView(*compact.toIntArray())
            )
        } catch (e: Exception) {
            Log.w(TAG, "设置 MediaStyle 失败", e)
        }

        return builder.build()
    }

    private fun updateNotification(st: PlayerState) {
        try {
            val mgr = getSystemService(NotificationManager::class.java)
            mgr?.notify(NOTIFICATION_ID, buildNotification(st))
        } catch (e: Exception) {
            Log.w(TAG, "更新通知失败", e)
        }
    }

    private fun action(icon: Int, title: String, actionName: String): Notification.Action {
        val i = Intent(this, PlaybackService::class.java).setAction(actionName)
        val pi = PendingIntent.getService(
            this, actionName.hashCode(), i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Action.Builder(Icon.createWithResource(this, icon), title, pi).build()
    }

    private fun openAppIntent(): PendingIntent {
        val i = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            this, 0, i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun startForegroundCompat(n: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            if (mgr?.getNotificationChannel(CHANNEL_ID) == null) {
                mgr?.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "播放控制", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "后台播放时的媒体控制"
                        setShowBadge(false)
                    }
                )
            }
        }
    }

    companion object {
        private const val TAG = "PlaybackService"
        private const val CHANNEL_ID = "bilimusic_playback"
        private const val NOTIFICATION_ID = 1001

        const val ACTION_TOGGLE = "com.bilimusic.app.TOGGLE"
        const val ACTION_PREV = "com.bilimusic.app.PREV"
        const val ACTION_NEXT = "com.bilimusic.app.NEXT"
    }
}

