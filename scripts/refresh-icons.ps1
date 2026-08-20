#requires -Version 5.1
<#
.SYNOPSIS
  从 icons/app-icon-v6/02-star-chevron-s.png(JPEG 字节、.png 扩展名)
  生成 Tauri 打包所需的全部图标到 src-tauri/icons/，并替换 docs/assets/starhub-logo.png。

.DESCRIPTION
  - 使用 System.Drawing 解码源图(JPEG),按需缩放写为 PNG
  - 不依赖 sharp / ImageMagick / magick
  - 保留 SVG/ICNS/Android/iOS 原状(分别需要 macOS 工具链或专用转换器)
  - 生成 PNG-in-ICO (Vista+ 兼容)

  生成清单:
    src-tauri/icons/icon.png            1024x1024
    src-tauri/icons/32x32.png             32x32
    src-tauri/icons/128x128.png          128x128
    src-tauri/icons/128x128@2x.png       256x256
    src-tauri/icons/icon.ico             16/32/48/64/128/256 多合一
    docs/assets/starhub-logo.png         1024x1024 (README 顶图)
#>

[CmdletBinding()]
param(
  [string]$RepoRoot = $PSScriptRoot,
  [string]$Source = 'icons\app-icon-v6\02-star-chevron-s.png',
  [string]$IconDir = 'src-tauri\icons',
  [string]$AssetDir = 'docs\assets'
)

if ($RepoRoot) { Set-Location -LiteralPath (Resolve-Path -LiteralPath $RepoRoot).Path }

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

function Resize-Png {
  param(
    [System.Drawing.Image]$Source,
    [int]$Size,
    [string]$OutPath
  )
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.Clear([System.Drawing.Color]::Transparent)
      $g.DrawImage($Source, 0, 0, $Size, $Size)
    } finally {
      $g.Dispose()
    }
    $dir = Split-Path -Parent $OutPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "  -> $OutPath ($Size x $Size)"
  } finally {
    $bmp.Dispose()
  }
}

function Draw-CompactWindowsIcon {
  param(
    [int]$Size,
    [System.Drawing.Graphics]$Graphics
  )
  $sizeValue = [int]$Size
  $Graphics.Clear([System.Drawing.Color]::Transparent)
  $Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $Graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $inset = [math]::Max(0.5, $sizeValue * 0.035)
  $corner = [math]::Max(2, $sizeValue * 0.18)
  $edge = $sizeValue - 2 * $inset
  $rect = New-Object System.Drawing.RectangleF($inset, $inset, $edge, $edge)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  try {
    $diameter = 2 * $corner
    $path.AddArc($rect.X, $rect.Y, $diameter, $diameter, 180, 90)
    $path.AddArc($rect.Right - $diameter, $rect.Y, $diameter, $diameter, 270, 90)
    $path.AddArc($rect.Right - $diameter, $rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(43, 109, 217))
    try { $Graphics.FillPath($brush, $path) } finally { $brush.Dispose() }
  } finally { $path.Dispose() }

  $fontSize = if ($sizeValue -le 16) { $sizeValue * 0.56 } else { $sizeValue * 0.44 }
  $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  try {
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
    $format.Trimming = [System.Drawing.StringTrimming]::None
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    try {
      $mark = if ($sizeValue -le 16) { 'S' } else { '>S' }
      $verticalNudge = if ($sizeValue -le 16) { -($sizeValue * 0.03) } else { -($sizeValue * 0.04) }
      $textRect = New-Object System.Drawing.RectangleF(0, $verticalNudge, $sizeValue, $sizeValue)
      $Graphics.DrawString($mark, $font, $brush, $textRect, $format)
    } finally { $brush.Dispose() }
  } finally {
    $format.Dispose()
    $font.Dispose()
  }
}

function Write-IcoFromPngs {
  param(
    [System.Drawing.Image]$Source,
    [int[]]$Sizes,
    [string]$OutPath
  )
  # PNG-in-ICO: ICONDIR + ICONDIRENTRY[](指向嵌入的 PNG 字节)
  $pngBlobs = @()
  foreach ($s in $Sizes) {
    $ms = New-Object System.IO.MemoryStream
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        if ($s -le 48) {
          Draw-CompactWindowsIcon -Size $s -Graphics $g
        } else {
          $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
          $g.Clear([System.Drawing.Color]::Transparent)
          $g.DrawImage($Source, 0, 0, $s, $s)
        }
      } finally { $g.Dispose() }
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bmp.Dispose() }
    $pngBlobs += ,@{ Size = $s; Bytes = $ms.ToArray() }
    $ms.Dispose()
  }

  $msOut = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($msOut)
  try {
    # ICONDIR (6 bytes): reserved(2)=0, type(2)=1, count(2)
    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$pngBlobs.Count)

    # Directory entries start at offset 6, each 16 bytes
    $dataOffset = 6 + 16 * $pngBlobs.Count
    foreach ($blob in $pngBlobs) {
      $w = if ($blob.Size -ge 256) { 0 } else { [byte]$blob.Size }
      $h = $w
      $bw.Write([byte]$w)               # width (0 means 256)
      $bw.Write([byte]$h)               # height
      $bw.Write([byte]0)                # palette count
      $bw.Write([byte]0)                # reserved
      $bw.Write([uint16]1)              # color planes
      $bw.Write([uint16]32)             # bits per pixel
      $bw.Write([uint32]$blob.Bytes.Length)
      $bw.Write([uint32]$dataOffset)
      $dataOffset += $blob.Bytes.Length
    }
    foreach ($blob in $pngBlobs) {
      $bw.Write($blob.Bytes)
    }
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($OutPath, $msOut.ToArray())
    Write-Host "  -> $OutPath (PNG-in-ICO: $($Sizes -join ',') px)"
  } finally {
    $bw.Dispose()
    $msOut.Dispose()
  }
}

if (-not (Test-Path $Source)) { throw "Source not found: $Source" }
Write-Host "[refresh-icons] decoding source: $Source"
# Clone the source into memory so it can safely be regenerated in place as icon.png.
$sourceFile = [System.Drawing.Image]::FromFile($Source)
try {
  $src = New-Object System.Drawing.Bitmap($sourceFile)
} finally {
  $sourceFile.Dispose()
}
try {
  Write-Host "[refresh-icons] source size: $($src.Width) x $($src.Height)"

  if (-not (Test-Path $IconDir)) { New-Item -ItemType Directory -Force -Path $IconDir | Out-Null }
  if (-not (Test-Path $AssetDir)) { New-Item -ItemType Directory -Force -Path $AssetDir | Out-Null }

  Write-Host "[refresh-icons] writing Tauri bundle icons:"
  Resize-Png -Source $src -Size 1024 -OutPath (Join-Path $IconDir 'icon.png')
  Resize-Png -Source $src -Size 32   -OutPath (Join-Path $IconDir '32x32.png')
  Resize-Png -Source $src -Size 128  -OutPath (Join-Path $IconDir '128x128.png')
  Resize-Png -Source $src -Size 256  -OutPath (Join-Path $IconDir '128x128@2x.png')

  Write-Host "[refresh-icons] writing README banner:"
  Resize-Png -Source $src -Size 1024 -OutPath (Join-Path $AssetDir 'starhub-logo.png')

  Write-Host "[refresh-icons] writing Windows .ico:"
  Write-IcoFromPngs -Source $src -Sizes @(16, 32, 48, 64, 128, 256) -OutPath (Join-Path $IconDir 'icon.ico')

  Write-Host "[refresh-icons] done."
} finally {
  $src.Dispose()
}