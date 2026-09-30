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
Copy-Item -LiteralPath (Join-Path $projectRoot "assets") -Destination $appTarget -Recurse
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

# The runtime shows the icon from assets/, but the file in Explorer carries
# whatever the executable was built with -- Electron's own. rcedit rewrites the
# resource section, and with it the name Windows shows in the taskbar tooltip.
$rcedit = Join-Path $projectRoot "node_modules\rcedit\bin\rcedit-x64.exe"
$iconPath = Join-Path $projectRoot "assets\app-icon.ico"
if ((Test-Path $rcedit) -and (Test-Path $iconPath)) {
  & $rcedit $appExe --set-icon $iconPath --set-version-string "ProductName" "DJI Osmo Desktop" --set-version-string "FileDescription" "DJI Osmo Desktop" --set-version-string "CompanyName" "DJI Osmo Desktop" --set-file-version $version --set-product-version $version | Out-Null
  Write-Output "icon: $iconPath applied to the executable"
} else {
  Write-Warning "rcedit or the icon is missing; the executable keeps Electron's icon."
}

@"
DJI Osmo Desktop $version - portable build
==========================================

1. Extract the WHOLE zip before running. The application reads files from the
   folder next to the executable, so running it from inside the zip will fail.
2. Launch "DJI Osmo Desktop.exe".
3. Keep only one instance open.

What is included
----------------
- The application itself (Electron runtime + source)
- ffmpeg and ffprobe in resources\bin
- Official Rec.709 LUTs and watermark images in resources
  (these remain the property of DJI and are used under their own terms)

GPU acceleration
----------------
Colour restoration uses the GPU through ffmpeg's libplacebo filter when the
graphics driver exposes Vulkan. If it does not, the export falls back to the CPU
automatically. No configuration is needed.

Where exports go
----------------
The export location is set in Settings. Exports never modify the files on the
camera card.

Windows SmartScreen
-------------------
This is an unsigned build, so Windows may show a warning the first time you run
it. Choose "More info" -> "Run anyway", or verify the download against the
SHA-256 listed on the release page.
"@ | Set-Content -LiteralPath (Join-Path $target "README.txt") -Encoding UTF8

Compress-Archive -LiteralPath $target -DestinationPath $zipPath -CompressionLevel Optimal
Get-Item $appExe, $zipPath | Select-Object FullName, Length, LastWriteTime
