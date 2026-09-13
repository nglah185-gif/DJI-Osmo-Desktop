# ELECTRON_VS_TAURI_BENCHMARK_V2

## Comparable results

Electron values are full in-app 640x360 preview measurements. Rust values stop at the paced Rust frame boundary. Full Tauri/WebView2 display values are unavailable, so they must not be treated as an end-to-end win.

| Test | Electron FPS | Rust boundary FPS | Full Tauri FPS | Electron avg frame | Rust avg frame | CPU | RSS | Dropped |
|---|---:|---:|---:|---:|---:|---|---|---|
| A native | 29.56 | 29.969 | UNAVAILABLE | 31.11 ms | 33.086 ms | Electron measured by process; Rust UNAVAILABLE | Electron ~648 MB total; Tauri shell 45.5 MB idle only | 0 / 0 |
| B D-Log LUT | 29.57 | 29.969 | UNAVAILABLE | 31.15 ms | 33.070 ms | UNAVAILABLE comparable | UNAVAILABLE comparable | 0 / 0 |
| C creative LUT | UNAVAILABLE | 29.970 | UNAVAILABLE | UNAVAILABLE | 32.858 ms | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE / 0 |
| D watermark | 32.01 | 29.919 | UNAVAILABLE | 31.41 ms | 33.088 ms | UNAVAILABLE comparable | UNAVAILABLE comparable | 0 / 0 |
| E combined | 32.18 | 29.897 | UNAVAILABLE | 31.23 ms | 32.760 ms | UNAVAILABLE comparable | UNAVAILABLE comparable | 0 / 0 |

## Interaction and transport comparison

| Metric | Electron | Tauri prototype |
|---|---|---|
| Effect switch | **Pre-fix benchmark:** frozen after update; next correct frame >5 s. **Current stress run:** 30 rapid filter/watermark updates stayed visible with no preview error. | UNAVAILABLE |
| Seek | **Pre-fix benchmark:** continuous stream freezes; still path 380-498 ms. Current trim/seek regression tests pass; a full latency series is UNAVAILABLE. | UNAVAILABLE |
| Raw frame size | 691,200 B | 691,200 B at Rust boundary |
| Per-frame UI transport | Electron IPC, 19.49-21.21 MB/s | UNAVAILABLE; real frames not bridged |
| Canvas upload | RGB24->RGBA JS + `putImageData`, 0.73-0.80 ms | UNAVAILABLE for real frames |
| 4K Main10 downscale | FFmpeg HW 70.3 fps; SW 32.0 fps | Same reusable FFmpeg result; no distinct Tauri measurement |

## Decision signal

The datasets do not show a Tauri performance advantage. Electron already sustains source rate with every reachable effect configuration. Its dominant observed failure is a restart-state bug, while raw-buffer IPC is a scaling risk rather than the current 640x360 bottleneck.
