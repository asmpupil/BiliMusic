@echo off
chcp 65001 >nul
cd /d "%~dp0"

where cargo >nul 2>nul
if errorlevel 1 (
    echo.
    echo   没找到 cargo，也就是没装 Rust 工具链。
    echo   装一个（一路回车即可）： https://rustup.rs
    echo.
    pause
    exit /b 1
)

echo.
echo   正在编译 BiliMusic.exe
echo   （第一次要几分钟，之后改了代码再编就快很多）
echo.

cargo build --release --manifest-path rs\Cargo.toml
if errorlevel 1 (
    echo.
    echo   编译失败，看上面的报错。
    echo.
    pause
    exit /b 1
)

copy /y "rs\target\release\bili-music.exe" "BiliMusic.exe" >nul

rem ── WebView2Loader 的链接方式由工具链决定 ──
rem   MSVC 工具链 -> 静态链接，不用管
rem   GNU  工具链 -> 动态链接，必须把这个 dll 跟 exe 放一起
set "FOUND="
for /d %%D in ("rs\target\release\build\webview2-com-sys-*") do (
    if exist "%%D\out\x64\WebView2Loader.dll" (
        copy /y "%%D\out\x64\WebView2Loader.dll" . >nul
        set "FOUND=1"
    )
)

echo.
echo   ============================================
echo     完成！
echo   ============================================
for %%A in ("BiliMusic.exe") do echo     主程序 : BiliMusic.exe  ^(%%~zA 字节^)
if defined FOUND (
    echo     还需要 : WebView2Loader.dll  —— 两个文件要放一起
    echo     原因   : 当前是 GNU 工具链，loader 是动态链接的
    echo              想单文件就装 MSVC 工具链，代码不用改
) else (
    echo     说明   : 单文件即可运行（loader 已静态链接）
)
echo.
pause
