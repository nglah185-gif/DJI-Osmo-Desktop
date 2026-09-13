# TAURI_PREVIEW_PROFILE_V2

## Scope and honesty boundary

The isolated prototype is in `bench/tauri-preview-prototype`. The production Electron app was not modified. Two components were verified:

1. A Rust release binary consumes complete 640x360 RGB24 frames from FFmpeg, applies A-E filter classes, and paces presentation at the 29.97 fps source rate.
2. A Tauri 2.11 / WebView2 release shell builds and launches with a live canvas surface.

The real video frames are not yet transported from Rust into WebView2. Therefore the A-E numbers below are **Rust + FFmpeg pipeline-boundary results**, not full Tauri display results. Full WebView2 A-E FPS, JS heap, effect-switch latency, seek latency, and frame transport cost are **UNAVAILABLE**.

## Build and launch verification

- Rust: 1.97.0, Cargo 1.97.0
- Tauri CLI: 2.11.4
- Tauri app build: PASS (`cargo tauri build --no-bundle`)
- Windows executable launch: PASS; responding after 3 s
- Shell process at idle: 47,718,400 B working set; 11,870,208 B private memory
- WebView2 canvas: initialized by the bundled static frontend

## A-E continuous Rust pipeline benchmark

Source: `dji-test-media/d log 10bit.LRF`, 1280x720 H.264 at 30000/1001. Output: 640x360 RGB24. Each run decoded a looped source and consumed/paced 900 complete frames over at least 30 s.

| Test | Frames | FPS | Avg frame ms | P95 | P99 | Dropped | Bytes/frame |
|---|---:|---:|---:|---:|---:|---:|---:|
| A native | 900 | 29.969 | 33.086 | 34.412 | 35.244 | 0 | 691,200 |
| B 33^3 D-Log LUT | 900 | 29.969 | 33.070 | 34.078 | 34.769 | 0 | 691,200 |
| C 65^3 creative LUT | 900 | 29.970 | 32.858 | 34.019 | 34.785 | 0 | 691,200 |
| D watermark | 900 | 29.919 | 33.088 | 34.395 | 34.978 | 0 | 691,200 |
| E combined | 900 | 29.897 | 32.760 | 34.465 | 35.646 | 0 | 691,200 |

The Rust boundary handled every configuration at source rate. The apparent 20.66-20.71 MB/s is the raw frame volume consumed inside the Rust process; it is not WebView IPC.

## What was and was not proved

- Proved: Rust orchestration, FFmpeg decode/effects, complete-frame assembly, pacing, Tauri compilation, WebView2 startup, and canvas availability all work on this machine.
- Not proved: an efficient Rust-to-WebView2 video-frame transport, WebView presentation of real frames, GPU LUT shaders, or lower end-to-end latency than Electron.
- Hardware decode: FFmpeg `-hwaccel auto` was used, matching the Electron test. Whether each 720p H.264 run selected a hardware decoder internally is UNAVAILABLE from the quiet benchmark output.
- 4K/10-bit HEVC: no separate Rust-specific decoder was implemented. The shared FFmpeg result is 70.3 fps HW and 32.0 fps SW when downscaling to 640x360; this does not establish a Tauri advantage.

## Conclusion

The prototype demonstrates feasibility, not superiority. Moving the same raw RGB24 frame path behind Tauri would still require a costly transport/upload design. Tauri alone does not remove the core architectural issue; a GPU-native shared texture or native renderer would be required for a materially different high-resolution path.

