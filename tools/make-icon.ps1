# 生成 BiliMusic 的图标：渐变圆角方块 + ♪ 音符
# 和播放器界面左上角 logo 的样式保持一致
#
# 产物：rs\icon.ico （256x256，PNG 压缩格式，Vista+ 原生支持）
#       rs\icon.png （同图，方便肉眼确认）
#
# 用法： powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1

Add-Type -AssemblyName System.Drawing

$size = 256
$icoPath = Join-Path $PSScriptRoot "..\rs\icon.ico"
$pngPath = Join-Path $PSScriptRoot "..\rs\icon.png"

$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# ---- 圆角方块 ----
$radius = [int]($size * 0.22)
$d = $radius * 2
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()

$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($size, $size)),
    [System.Drawing.Color]::FromArgb(78, 161, 255),   # #4ea1ff
    [System.Drawing.Color]::FromArgb(34, 211, 166)    # #22d3a6
)
$g.FillPath($brush, $path)

# ---- ♪ 音符 ----
$font = New-Object System.Drawing.Font("Segoe UI Symbol", [float]($size * 0.60), [System.Drawing.FontStyle]::Regular)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$fg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(6, 32, 46))
# ♪ 字形在字体里本身偏下，往上抬一点视觉上才居中
$rect = New-Object System.Drawing.RectangleF(0, -($size * 0.045), $size, $size)
$g.DrawString([string][char]0x266A, $font, $fg, $rect, $fmt)

$g.Dispose()

# ---- 存 PNG（顺便留一份给人看）----
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$bmp.Dispose()
$ms.Dispose()
[System.IO.File]::WriteAllBytes($pngPath, $png)

# ---- 包成 ICO ----
# 结构：6 字节主头 + 16 字节目录项 + PNG 数据
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)               # reserved
$bw.Write([UInt16]1)               # type: 1 = icon
$bw.Write([UInt16]1)               # 图像数量
$bw.Write([Byte]0)                 # 宽（0 表示 256）
$bw.Write([Byte]0)                 # 高（0 表示 256）
$bw.Write([Byte]0)                 # 调色板数
$bw.Write([Byte]0)                 # reserved
$bw.Write([UInt16]1)               # color planes
$bw.Write([UInt16]32)              # 位深
$bw.Write([UInt32]$png.Length)     # 数据长度
$bw.Write([UInt32]22)              # 数据偏移（6 + 16）
$bw.Write($png)
$bw.Close()
$fs.Close()

"ICO : $icoPath  ($([math]::Round((Get-Item $icoPath).Length / 1KB, 1)) KB)"
"PNG : $pngPath  ($([math]::Round((Get-Item $pngPath).Length / 1KB, 1)) KB)"
