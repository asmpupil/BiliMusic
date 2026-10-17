@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   ============================================
echo     构建 BiliMusic.apk
echo   ============================================
echo.

rem ---------- 定位 JDK ----------
if not defined JAVA_HOME (
    for /d %%D in ("C:\Program Files\Eclipse Adoptium\jdk-*") do set "JAVA_HOME=%%D"
)
if not defined JAVA_HOME (
    echo   [x] 没找到 JDK，去装一个： https://adoptium.net
    pause
    exit /b 1
)
echo   JAVA_HOME    = %JAVA_HOME%

rem ---------- 定位 Android SDK ----------
if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not exist "%ANDROID_HOME%\platform-tools" (
    echo   [x] 没找到 Android SDK：%ANDROID_HOME%
    pause
    exit /b 1
)
echo   ANDROID_HOME = %ANDROID_HOME%

rem ---------- 告诉 Gradle 去哪找 SDK ----------
> "android\local.properties" echo sdk.dir=%ANDROID_HOME:\=/%

rem ---------- 定位 Gradle ----------
set "GRADLE=%~dp0tools\gradle-8.11\bin\gradle.bat"
if not exist "%GRADLE%" (
    echo   [x] 没找到 Gradle：%GRADLE%
    pause
    exit /b 1
)
echo   GRADLE       = %GRADLE%

echo.
echo   开始构建（第一次要下载依赖，可能几分钟）...
echo.

call "%GRADLE%" -p android assembleDebug --no-daemon
if errorlevel 1 (
    echo.
    echo   [x] 构建失败，看上面的报错。
    pause
    exit /b 1
)

copy /y "android\app\build\outputs\apk\debug\app-debug.apk" "BiliMusic.apk" >nul

echo.
echo   ============================================
echo     完成！
echo   ============================================
for %%A in ("BiliMusic.apk") do echo     产物: BiliMusic.apk  ^(%%~zA 字节^)
echo.
echo   装到手机：把 BiliMusic.apk 传过去，允许"未知来源"安装即可。
echo.
pause
