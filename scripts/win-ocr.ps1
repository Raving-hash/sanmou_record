# Windows built-in OCR (Windows.Media.Ocr). No service, no install, offline.
#
#   -Dir  <folder of pngs>   -> writes words-XX.jsonl next to each frame
#   -Path <one png>          -> writes JSONL to -Out (or stdout)
#
# Emits JSONL, one "word" per line with its pixel box:
#   {"text":"84","x":1209,"y":312,"w":24,"h":24}
#
# Words, not lines: an OCR line groups every column that shares a baseline, so
# the name, the record, the kills and the points all come back as one string and
# column parsing dies. Per-word boxes keep the columns separable.
#
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI.
param(
  [string]$Path = '',
  [string]$Dir = '',
  [string]$Out = '',
  [string]$Lang = 'zh-Hans-CN',
  [string]$Tag = '',
  # Upscale before OCR. Windows OCR drops ~30px glyphs (the gold rank digits,
  # the 2-3 digit score), and 2x is where it stops doing that. Boxes are divided
  # back by $Scale so column math still works on original pixels.
  #
  # Neither scale is complete on its own: at 1x the rank digits on the medal
  # shields survive but row #1's score goes missing, at 2x it is the opposite.
  # The caller runs both and unites the word sets -- see rank-shot.js.
  [double]$Scale = 2
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($Lang)))
if (-not $engine) { throw "no OCR language pack for $Lang (Settings > Time & language > Language)" }

function Read-Words([string]$file) {
  $src = $file
  $tmp = $null
  if ($Scale -ne 1) {
    $img = [System.Drawing.Image]::FromFile($file)
    $bw = [int]($img.Width * $Scale)
    $bh = [int]($img.Height * $Scale)
    $bmp = New-Object System.Drawing.Bitmap($bw, $bh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($img, 0, 0, $bw, $bh)
    $tmp = Join-Path $env:TEMP ([guid]::NewGuid().ToString() + '.png')
    $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); $img.Dispose()
    $src = $tmp
  }

  $sf = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($src)) ([Windows.Storage.StorageFile])
  $stream = Await ($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in $result.Lines) {
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect
      # boxes come back in scaled pixels; report original ones
      $lines.Add((ConvertTo-Json -Compress -InputObject ([ordered]@{
        text = $w.Text
        x    = [math]::Round($r.X / $Scale, 1)
        y    = [math]::Round($r.Y / $Scale, 1)
        w    = [math]::Round($r.Width / $Scale, 1)
        h    = [math]::Round($r.Height / $Scale, 1)
      })))
    }
  }
  $stream.Dispose()
  if ($tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  return $lines
}

if ($Dir) {
  $files = Get-ChildItem -Path $Dir -Filter '*.png' | Sort-Object Name
  if (-not $files) { throw "no png in $Dir" }
  foreach ($f in $files) {
    $suffix = if ($Tag) { '.' + $Tag } else { '' }
    $target = Join-Path $Dir ($f.BaseName + $suffix + '.words.jsonl')
    $w = Read-Words $f.FullName
    [System.IO.File]::WriteAllLines($target, $w, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output $target
  }
  exit 0
}

if (-not $Path) { throw 'give -Path <png> or -Dir <folder>' }
$words = Read-Words $Path
if ($Out) {
  [System.IO.File]::WriteAllLines($Out, $words, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output $Out
} else {
  $words | ForEach-Object { Write-Output $_ }
}
