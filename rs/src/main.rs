//! BiliMusic — B站纯音频播放器（Windows 桌面版）
//!
//! 用系统自带的 **WebView2 Runtime** 承载页面，播放器脚本在编译期就嵌进 exe，
//! 所以不需要打包浏览器内核，产物只有几 MB。
//!
//! 两个关键点：
//! 1. `with_initialization_script` 等价于 WebView2 的
//!    `AddScriptToExecuteOnDocumentCreated`——脚本在文档创建时就注入，
//!    比“等页面加载完再 evaluate_js”干净得多（不会跟 splash 页抢）。
//! 2. `with_autoplay(true)` 必须开，否则脚本里自己调 `play()` 会被
//!    浏览器的自动播放策略拦下（要用户先点一下才行）。

// Release 下不挂控制台：否则双击 exe 会跟在后面一个黑框。
// Debug 构建保留，方便开发时看 println 输出。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

const START_URL: &str = "https://www.bilibili.com/";

/// 播放器脚本：编译期直接嵌进 exe，不用额外带一个 .js 文件
const PLAYER_JS: &str = include_str!("../../bili-music.js");

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let event_loop = EventLoop::new();

    // 窗口尺寸按屏幕自适应——之前写死 1200x800，在 1080p 上几乎顶到任务栏
    let (win_w, win_h) = {
        let (sw, sh) = event_loop
            .primary_monitor()
            .map(|m| {
                let s = m.size();
                let k = m.scale_factor();
                (s.width as f64 / k, s.height as f64 / k)
            })
            .unwrap_or((1920.0, 1080.0));
        // 宽取 58%、高取 62%，再夹到合理区间
        ((sw * 0.58).clamp(900.0, 1200.0), (sh * 0.62).clamp(560.0, 720.0))
    };

    let window = WindowBuilder::new()
        .with_title("BiliMusic — B站纯音频播放器")
        .with_inner_size(LogicalSize::new(win_w, win_h))
        .with_min_inner_size(LogicalSize::new(880.0, 560.0))
        .build(&event_loop)?;

    // exe 里嵌的图标资源不会自动变窗口图标，不设的话标题栏 / Alt+Tab
    // 显示的是 Windows 默认图标（空白文档）。
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowExtWindows;
        unsafe { win32_icon::apply_to(window.hwnd()) };
    }

    // WebView2 的 user data 放在 exe 旁边：绿色便携，B站登录态也能记住。
    // 默认位置在 %LOCALAPPDATA%，多人共用机器时不好携带，所以显式指定。
    let data_dir: PathBuf = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("BiliMusic-data")))
        .unwrap_or_else(|| PathBuf::from("BiliMusic-data"));

    let mut web_context = wry::WebContext::new(Some(data_dir));

    let webview = match WebViewBuilder::new_with_web_context(&mut web_context)
        .with_url(START_URL)
        .with_initialization_script(PLAYER_JS)
        .with_autoplay(true)
        .build(&window)
    {
        Ok(wv) => wv,
        Err(err) => {
            // 最常见的原因就是系统没装 WebView2 Runtime。
            // release 下没有控制台，eprintln 看不到，所以必须弹个框。
            let msg = format!(
                "创建 WebView2 失败：\n{err}\n\n\
                 多半是系统缺少 WebView2 Runtime。\n\
                 Windows 10/11 一般随 Edge 自带；\n\
                 没有的话去这里装一下：\n\
                 https://developer.microsoft.com/microsoft-edge/webview2/"
            );
            eprintln!("{msg}");
            win32_ui::error("BiliMusic 启动失败", &msg);
            std::process::exit(1);
        }
    };

    event_loop.run(move |event, _, control_flow| {
        // 让 webview 活到事件循环结束（drop 了窗口就白了）
        let _ = &webview;

        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }
        // 窗口拉伸时 webview 会自动跟随——Windows 上 wry 内部已经处理了
    })
}

// ────────────────────────────────────────────────────────────────
//  把 exe 里的图标资源（id = 1，由 build.rs 通过 winres 写入）设成窗口图标
// ────────────────────────────────────────────────────────────────
#[cfg(windows)]
mod win32_icon {
    use std::ffi::c_void;

    const WM_SETICON: u32 = 0x0080;
    const ICON_SMALL: usize = 0; // 标题栏
    const ICON_BIG: usize = 1; // Alt+Tab

    #[link(name = "user32")]
    unsafe extern "system" {
        fn LoadIconW(hinstance: *mut c_void, name: *const u16) -> *mut c_void;
        fn SendMessageW(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> isize;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
    }

    /// `MAKEINTRESOURCE(1)`：把整数 1 直接当资源名指针用
    pub unsafe fn apply_to(hwnd: isize) {
        let hicon = unsafe { LoadIconW(GetModuleHandleW(std::ptr::null()), 1 as *const u16) };
        if hicon.is_null() {
            return;
        }
        let h = hwnd as *mut c_void;
        unsafe {
            SendMessageW(h, WM_SETICON, ICON_BIG, hicon as isize);
            SendMessageW(h, WM_SETICON, ICON_SMALL, hicon as isize);
        }
    }
}

// ────────────────────────────────────────────────────────────────
//  没有控制台时的报错手段（release 下 eprintln 根本看不到）
// ────────────────────────────────────────────────────────────────
#[cfg(windows)]
mod win32_ui {
    use std::ffi::c_void;

    const MB_ICONERROR: u32 = 0x0000_0010;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(hwnd: *mut c_void, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }

    pub fn error(caption: &str, text: &str) {
        fn wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        }
        let c = wide(caption);
        let t = wide(text);
        unsafe {
            MessageBoxW(std::ptr::null_mut(), t.as_ptr(), c.as_ptr(), MB_ICONERROR);
        }
    }
}

#[cfg(not(windows))]
mod win32_ui {
    pub fn error(caption: &str, text: &str) {
        eprintln!("{caption}: {text}");
    }
}
