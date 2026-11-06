param(
  [int]$MaxWidth = 798,
  [string]$OutDir = ''
)

# A1 的降级抓屏：不依赖 Python，一条 PowerShell 拿到整屏 PNG。
# 只做一件事：抓「所有显示器合起来的桌面」，缩到 MaxWidth，写 PNG，回一行 JSON。
#
# 为什么第一行就 SetProcessDPIAware：不开 DPI 感知时 SystemInformation.VirtualScreen
# 报的是缩放后的逻辑尺寸（150% 下 2560×1440 会报成 1707×960），CopyFromScreen 也只
# 抓左上那一块。开了之后坐标与像素 1:1，A2 的 sidecar 用同一套坐标系才不会错位。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not $OutDir) {
  $OutDir = Join-Path $env:TEMP 'dsh-glance'
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

function Write-Result($obj) {
  [Console]::Out.Write((ConvertTo-Json -Compress -Depth 6 $obj))
  [Console]::Out.Flush()
}

function Fail($code, $message) {
  Write-Result @{ ok = $false; error = @{ code = $code; message = [string]$message } }
  exit 1
}

$bmp = $null
$small = $null
$g = $null
$g2 = $null

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  if (-not ('GlanceDpi' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class GlanceDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
  }
  [void][GlanceDpi]::SetProcessDPIAware()

  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
    Fail 'CAPTURE_FAILED' 'virtual screen has no area'
  }

  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)

  $scale = [Math]::Min(1.0, [double]$MaxWidth / [double]$bounds.Width)
  $width = [int][Math]::Round($bounds.Width * $scale)
  $height = [int][Math]::Round($bounds.Height * $scale)
  if ($width -lt 1) { $width = 1 }
  if ($height -lt 1) { $height = 1 }

  $small = New-Object System.Drawing.Bitmap $width, $height
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g2.DrawImage($bmp, 0, 0, $width, $height)

  [void](New-Item -ItemType Directory -Force -Path $OutDir)
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
  $path = Join-Path $OutDir ("shot-$stamp.png")
  $small.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = (Get-Item $path).Length

  $monitors = @()
  foreach ($m in [System.Windows.Forms.Screen]::AllScreens) {
    $monitors += @{ primary = [bool]$m.Primary; w = [int]$m.Bounds.Width; h = [int]$m.Bounds.Height }
  }

  $sw.Stop()
  Write-Result @{
    ok = $true
    path = $path
    width = [int]$width
    height = [int]$height
    bytes = [int]$bytes
    ms = [int]$sw.ElapsedMilliseconds
    screen = @{ x = [int]$bounds.Left; y = [int]$bounds.Top; w = [int]$bounds.Width; h = [int]$bounds.Height; dpiAware = $true }
    monitors = $monitors
  }
} catch {
  Fail 'CAPTURE_FAILED' $_.Exception.Message
} finally {
  if ($g) { $g.Dispose() }
  if ($g2) { $g2.Dispose() }
  if ($small) { $small.Dispose() }
  if ($bmp) { $bmp.Dispose() }
}
