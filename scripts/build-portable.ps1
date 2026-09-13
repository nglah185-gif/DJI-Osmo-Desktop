$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspaceRoot = (Resolve-Path (Join-Path $projectRoot "..")).Path
$version = (Get-Content (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json).version
$releaseRoot = Join-Path $projectRoot "release"
$packageName = "DJI-Osmo-Desktop-$version-win-x64-portable"
$target = Join-Path $releaseRoot $packageName
$zipPath = Join-Path $releaseRoot ($packageName + ".zip")
$electronDist = Join-Path $projectRoot "node_modules\electron\dist"
$appTarget = Join-Path $target "resources\app"

if (-not (Test-Path $electronDist)) { throw "Electron runtime is missing. Run npm install first." }
$localBin = Join-Path $projectRoot "bin"
if (-not (Test-Path (Join-Path $localBin "ffmpeg.exe"))) { throw "bin\ffmpeg.exe is required for this build. Use the ffmpeg 'full' build (libplacebo) so GPU LUT export works." }
if (-not (Test-Path (Join-Path $localBin "ffprobe.exe"))) { throw "bin\ffprobe.exe is required for this build." }

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
if (Test-Path $target) {
  $resolvedTarget = (Resolve-Path $target).Path
  if (-not $resolvedTarget.StartsWith($releaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to replace target outside release directory." }
  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

New-Item -ItemType Directory -Force -Path $target | Out-Null
Get-ChildItem -LiteralPath $electronDist -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force }
Remove-Item -LiteralPath (Join-Path $target "resources\default_app.asar") -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $appTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "package.json") -Destination $appTarget
Copy-Item -LiteralPath (Join-Path $projectRoot "src") -Destination $appTarget -Recurse
Copy-Item -LiteralPath (Join-Path $workspaceRoot "cube&luts") -Destination (Join-Path $target "resources") -Recurse
$extraLutRoot = Join-Path $workspaceRoot "lut&log"
if (Test-Path -LiteralPath $extraLutRoot) {
  Copy-Item -LiteralPath $extraLutRoot -Destination (Join-Path $target "resources") -Recurse
}

$watermarkTarget = Join-Path $target "resources\watermark"
New-Item -ItemType Directory -Force -Path $watermarkTarget | Out-Null
Get-ChildItem -LiteralPath (Join-Path $workspaceRoot "watermark") -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $watermarkTarget -Force }

$binTarget = Join-Path $target "resources\bin"
New-Item -ItemType Directory -Force -Path $binTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $localBin "ffmpeg.exe") -Destination $binTarget
Copy-Item -LiteralPath (Join-Path $localBin "ffprobe.exe") -Destination $binTarget

$electronExe = Join-Path $target "electron.exe"
$appExe = Join-Path $target "DJI Osmo Desktop.exe"
Move-Item -LiteralPath $electronExe -Destination $appExe

@"
DJI Osmo Desktop $version - Portable Test Build

1. Extract the complete ZIP before running.
2. Launch DJI Osmo Desktop.exe.
3. Keep only one application instance open.
4. This is an unsigned test build; Windows SmartScreen may show a warning.
"@ | Set-Content -LiteralPath (Join-Path $target "README.txt") -Encoding UTF8

Compress-Archive -LiteralPath $target -DestinationPath $zipPath -CompressionLevel Optimal
Get-Item $appExe, $zipPath | Select-Object FullName, Length, LastWriteTime
