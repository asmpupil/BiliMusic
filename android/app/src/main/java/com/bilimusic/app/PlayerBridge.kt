package com.bilimusic.app

/**
 * JS 上报过来的播放状态（字段名与 `bili-music.js` 里的 payload 一一对应）。
 */
data class PlayerState(
    val playing: Boolean = false,
    val title: String = "",
    val author: String = "",
    val cover: String = "",
    val durationMs: Long = 0,
    val positionMs: Long = 0,
    val hasPrev: Boolean = false,
    val hasNext: Boolean = false,
)

/**
 * Activity 和 Service 之间的桥。
 *
 * 数据流：
 *   通知栏按钮 → PlaybackService(MediaSession.Callback) → PlayerBridge.command()
 *                                                          ↓
 *                                              MainActivity.sendCommand
 *                                                          ↓
 *                                       webView.evaluateJavascript("__bmCmd('pause')")
 *
 *   JS(notifyNative) → BiliMusicAndroid.onState(json) → PlayerBridge.report()
 *                                                          ↓
 *                                          PlaybackService.applyState()
 *                                                          ↓
 *                                     PlaybackState + 通知栏文字/按钮
 *
 * 之所以走静态单例而不是 bindService：Activity 和 Service 生命周期不同步，
 * 而且这里只有单向的状态/命令转发，用绑定的成本远大于收益。
 */
object PlayerBridge {

    /** 把命令送进 WebView。由 MainActivity 注册，WebView 销毁后置空。 */
    @Volatile
    var sendCommand: ((String) -> Unit)? = null

    /** 状态变化回调。由 PlaybackService 注册。 */
    @Volatile
    var onState: ((PlayerState) -> Unit)? = null

    /** 最近一次状态。Service 比 Activity 后起来时用它兜底，免得通知栏空白。 */
    @Volatile
    var lastState: PlayerState = PlayerState()

    fun report(state: PlayerState) {
        lastState = state
        onState?.invoke(state)
    }

    fun command(cmd: String) {
        sendCommand?.invoke(cmd)
    }
}
