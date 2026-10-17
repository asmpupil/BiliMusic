# 从 rs\icon.png 生成 Android 各密度的启动图标
# 用法： powershell -ExecutionPolicy Bypass -File tools\make-android-icons.ps1

Add-Type -AssemblyName System.Drawing

$src = Join-Path $PSScriptRoot "..\rs\icon.png"
$res = Join-Path $PSScriptRoot "..\android\app\src\main\res"

if (-not (Test-Path $src)) {
    "找不到 $src —— 请先跑 tools\make-icon.ps1"
    exit 1
}

# Android 各密度对应的启动图标边长（px）
$sizes = [ordered]@{
    "mipmap-mdpi"    = 48
    "mipmap-hdpi"    = 72
    "mipmap-xhdpi"   = 96
    "mipmap-xxhdpi"  = 144
    "mipmap-xxxhdpi" = 192
}

$img = [System.Drawing.Image]::FromFile((Resolve-Path $src).Path)

foreach ($dir in $sizes.Keys) {
    $size = $sizes[$dir]
    $outDir = Join-Path $res $dir
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($img, 0, 0, $size, $size)
    $g.Dispose()

    $out = Join-Path $outDir "ic_launcher.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    "  $dir  ->  $size x $size"
}

$img.Dispose()
"图标生成完毕"
