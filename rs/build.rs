//! 编译期把图标和版本信息写进 exe。
//!
//! `winres` 会自动挑工具：MSVC 工具链用 `rc.exe`，GNU 工具链用 `windres`，
//! 所以两种工具链下都能正常出带图标的 exe。

fn main() {
    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("icon.ico");
        res.set("ProductName", "BiliMusic");
        res.set("FileDescription", "B站纯音频播放器");
        if let Err(e) = res.compile() {
            println!("cargo:warning=[build.rs] 写入图标资源失败: {e}");
        }

        // ★ 第二个坑：winres 只把资源打包成 libresource.a 并给一条 `-l resource`，
        //   但 GNU ld 对静态库只会提取「被引用的成员」，而资源目标文件里
        //   没有任何符号被引用 —— 于是整个资源都被跳过了。
        //   直接把 resource.o 当链接输入，才能确保它进 exe。
        if let Ok(out_dir) = std::env::var("OUT_DIR") {
            let obj = std::path::Path::new(&out_dir).join("resource.o");
            if obj.exists() {
                println!("cargo:rustc-link-arg-bins={}", obj.display());
            }
        }
    }

    // ★ 关键：GNU 工具链默认给链接器带 --gc-sections，
    //   而 windres 生成的资源段（.rsrc）没有任何符号引用它，
    //   会被当成垃圾丢掉 —— 图标就是这么没的。
    //   MSVC 默认不这么做，所以用 MSVC 的人碰不到这个坑。
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu") {
        println!("cargo:rustc-link-arg-bins=-Wl,--no-gc-sections");
    }

    // 图标换了要重新编译
    println!("cargo:rerun-if-changed=icon.ico");
}
