
# ELECTRON_PREVIEW_RAWDATA_V2

Raw benchmark data for ELECTRON_PREVIEW_PROFILE_V2.md. Machine JSON lives under E:\dji_desktop(1)\workspace\perf-bench\ (see Appendix of the profile doc). This file is the readable consolidated summary.

## 1. Backend ffmpeg pipeline throughput (exact app buildFilterGraph, real 720p 29.97 LRF)

Source: d log 10bit.LRF (and 普通色彩.LRF), -hwaccel auto, raw RGB24 out, -t bounded.

| cfg | scale | frames | ms | fps | filterGraph |
|-----|-------|--------|-----|-----|-------------|
| A | 640x360 | 52 | 333 | 156.2 | [0:v]format=rgb24[input_interpreted];[input_interpreted]format=rgb24[working_rgb];[working_rgb]null[overlay];[overlay]format=rgb24,scale=640:360[outv] |
| B | 640x360 | 52 | 503 | 103.4 | [0:v]format=rgb24[input_interpreted];[input_interpreted]lut3d=file='...D-Log M to Rec.709 V1.cube'[technical_out];[technical_out]format=rgb24[working_rgb];[working_rgb]null[overlay];[overlay]format=rgb24,scale=640:360[outv] |
| C | 640x360 | 52 | 667 | 78.0 | [0:v]format=rgb24[input_interpreted];[input_interpreted]format=rgb24[working_rgb];[working_rgb]lut3d=file='...Forest Pro.cube'[style0_lut];[style0_lut]null[overlay];[overlay]format=rgb24,scale=640:360[outv] |
| D | 640x360 | 53 | 395 | 134.2 | [0:v]format=rgb24[input_interpreted];[input_interpreted]format=rgb24[working_rgb];[1:v]format=rgba,colorchannelmixer=aa=1.0000,scale=iw*0.5000:-1[watermark];[working_rgb][watermark]overlay=...;[overlay]format=rgb24,scale=640:360[outv] |
| E | 640x360 | 53 | 933 | 56.8 | format=rgb24 -> lut3d(D-Log) -> lut3d(Forest) -> overlay(watermark) -> scale=640:360 |
| A | 1280x720 | 52 | 324 | 160.5 | (same as A, scale=1280:720) |
| E | 1280x720 | 53 | 900 | 58.9 | (same as E, scale=1280:720) |

## 2. In-app continuous stream (over ~30 s each) - render is always 640x360

Source resolved to a 640x360 H.264 fallback proxy (local assets have no LRF companion); output RGB24 640x360 = 691,200 B/frame.

| cfg | fps | avg frame ms | p95 | p99 | max | frames | dropped(vs899) | IPC MB/s | paint avg/p95 ms | first-frame lag ms |
|-----|-----|-------------|-----|-----|-----|--------|---------------|----------|-------------------|--------------------|
| A | 29.56 | 31.11 | 37 | 43 | 50 | 900 | +0.9 | 19.49 | 0.73 / 1.10 | 413 |
| B | 29.57 | 31.15 | 36 | 42 | 60 | 900 | +0.9 | 19.49 | 0.80 / 1.20 | 410 |
| D | 32.01 | 31.41 | 38 | 45 | 59 | 973 | +73.9 | 21.10 | 0.78 / 1.20 | 412 |
| E | 32.18 | 31.23 | 37 | 42 | 52 | 980 | +80.9 | 21.21 | 0.80 / 1.20 | 627 |

bytesPerFrame = 691200 (confirmed all configs). C = UNAVAILABLE in-app (no "creative-only" preset).

## 3. Effect-switch / seek freeze confirmation

Fresh stream then editor:preview-update to Forest:
- baselineFrames before update: 11 (streaming)
- updateLatencyMs: 3 (stale in-flight frame, NOT a new-effect frame)
- framesIn2.5sAfterUpdate: 1  -> STREAM FROZEN

Seek (renderPreviewSeek to 50%) during streaming:
- seekLatencyMs: 3 (stale frame), frames in 5 s after seek: 1 -> STREAM FROZEN

Conclusion: continuous preview freezes after ANY update/seek (session.stopping never reset, preview-frame-streamer.js:124/221).

## 4. Single-frame still path (editor:preview-frame, 1280x720 PNG data URL)

| call | wall ms | ffmpeg ms | PNG bytes |
|------|---------|-----------|-----------|
| A @ 0s | 261 | 258 | 351354 |
| B-Dlog @ 0s | 304 | 301 | 380582 |
| E-ForestWM @ 0s | 498 | 495 | 384738 |
| A @ 50% | 383 | 380 | 523494 |
| A @ 75% | 387 | 384 | 583886 |

## 5. 4K/10-bit HEVC (d log 10bit.MP4: HEVC Main10 3840x2160 yuv420p10le 59.94fps 1.73s)

| test | HW | SW |
|------|----|----|
| decode+downscale->640x360 RGB24 fps | 70.3 | 32.0 |
| decode->null(+downscale) fps | 67.8 | - |
| decode-only fps | ~76.6 | - |
| seek first-frame @10/25/50/75/90% | 543/667/549/560/398 ms | 1089/1223/1273/1185/733 ms |

## 6. System metrics (during steady streaming)

- main: ~10% CPU, 167-176 MB RSS
- renderer: ~12% CPU, 145-154 MB RSS, JS heap 2.2 MB used / 4.5 MB total
- GPU: ~0.5% CPU, 281-302 MB RSS
- ffmpeg child: ~73% CPU (one core), 117 MB RSS
- total Electron RSS ~648 MB
- GPU status: WebGL=true, WebGPU=true, devicePixelRatio 1.5, 12 threads; preview uses canvas2D putImageData (no GLSL)
 
