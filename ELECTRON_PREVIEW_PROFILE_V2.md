
# ELECTRON_PREVIEW_PROFILE_V2

**Project:** DJI Osmo Desktop V2 - Phase 4.6 Electron vs Rust/Tauri performance-architecture assessment
**Author:** electron-profiler (team phase46-perf-arch-decision)
**Scope:** Static code audit + runtime profiling of the Electron preview pipeline. **No production code was modified.** All benchmarks measured (no speculation); fields that could not be measured are marked **UNAVAILABLE**.

---

## 0. TL;DR - Headline findings

### Current regression evidence (2026-08-29)

After the generation-guarded restart fix and non-blocking replacement launch,
the real Electron window was driven through **60 consecutive edits** on the
camera's D-Log M clip (creative looks, watermark enable/position, playback
speed, and crop). At samples 0/10/20/30/40/50 and at the final state the canvas
remained visible, the error banner remained hidden, and the live-effects state
remained active. Final controls were Nature Pro, watermark enabled, 2x speed,
and 0.12 crop. No new ffmpeg child remained after the run; the only observed
ffmpeg process was a pre-existing orphan from the older Electron tree.

| # | Finding | Evidence |
|---|---------|----------|
| **1** | **Historical defect (fixed):** an effect change/seek could freeze the continuous preview because a replacement launch inherited the stopping state and stale child events could race the new child. | The pre-fix benchmark below records the failure. The current `preview-frame-streamer.js` resets `session.stopping` before launch and validates `launchGeneration` in stdout/timer/close paths; the 30-operation real-window stress run completed with a visible canvas and no `preview:error`. |
| **2** | **The decode+effect backend is NOT the bottleneck.** At 640x360 and 1280x720 the ffmpeg filter graph sustains 57-160 fps on the real 720p 29.97 LRF - well above the 29.97 source. | ffmpeg throughput bench (all 5 configs, both scales): A=156-163, B=103, C=78, D=127-134, E=57-59 fps. |
| **3** | **Per-frame IPC pushes 691,200 bytes (640x360x3 raw RGB24) at ~19.5-21.2 MB/s.** This is the headline architectural cost of the preview channel. | preview-frame-streamer.js:190 sends a raw Buffer per frame; measured 691,200 B/frame x ~30-32 fps = 19.5-21.2 MB/s over 30s. |
| **4** | **The live preview is software 2D-canvas putImageData, not WebGL/WebGPU.** WebGL and WebGPU ARE available in the renderer but unused for the preview. | preview-canvas-surface.js:15,42 (2D context + putImageData, "No GLSL"); measured WebGL=true, WebGPU present, renderer paints 640x360 via RGB24->RGBA->putImageData in ~0.73-0.80 ms/frame. |
| **5** | **The single-frame still path costs 261-498 ms per 1280x720 frame** (per-frame ffmpeg spawn) - only ~2-4 fps if used for live preview. | editor:preview-frame -> ffmpeg-frame-renderer.js:10 (per-frame spawn, PNG out); measured A=261 ms, B=304 ms, E=498 ms. |
| **6** | **4K/10-bit HEVC original preview is feasible with hardware decode** (70 fps decode+downscale >= 59.94 source) **but NOT with software decode** (only 32 fps). | 4K HEVC bench: HW decode+downscale 640x360 = 70.3 fps; SW = 32.0 fps; HW seek first-frame 398-667 ms. |

---

## 1. Pipeline anatomy (17 questions)

**Actual pipeline (correcting the team-goal framing):** the live effect preview does **NOT** capture frames from the <video> element. It is:

    LRF/MP4 -> [main process] spawn ffmpeg (decode + filter graph) -> raw RGB24 on stdout
           -> pace timer + backpressure -> webContents.send("preview:frame", {data: Buffer})
           -> [renderer] ipcRenderer.on("preview:frame") -> preview-canvas-surface.paint()
           -> RGB24->RGBA (JS loop) -> ctx.putImageData() -> 2D canvas -> [GPU] composite -> display

The <video id="preview-video"> element is used **only as the timeline clock** (currentTime, timeupdate, seek) and for browse-mode direct playback. In edit mode the canvas shows the ffmpeg effect stream.

### 1.1 Where is the video decoded?
**In the main process, by a long-lived spawned ffmpeg process** (preview-frame-streamer.js:160). One ffmpeg per asset/session. Decode mode: -hwaccel auto on win32 (preview-frame-streamer.js:139). *Runtime:* ffmpeg child measured at **~73% of one core** while streaming, 117 MB RSS. A second decode happens in Chromium's media stack for the <video> clock (browse mode), not used for the effect preview.

### 1.2 Where is the LUT applied?
**Inside ffmpeg via lut3d** (filter-graph-builder.js:24):
    [working_rgb]lut3d=file='<...>/DJI OSMO Action 4 D-Log M to Rec.709 V1.cube'[technical_out]
The technical/D-Log to Rec.709 CUBE (33^3) is an ffmpeg lut3d filter on the decoded stream.

### 1.3 Where is the Creative Look applied?
**Inside ffmpeg via a second lut3d** per style (filter-graph-builder.js:31):
    [working_rgb]lut3d=file='<...>/DJI OSMO Action 4 Forest Pro.cube'[style0_lut]
For config E: format=rgb24 -> lut3d(D-Log) -> lut3d(Forest) -> overlay -> scale -> rgb24 (see raw data filterGraph).

### 1.4 Where is the watermark applied?
**Inside ffmpeg via overlay**, with the PNG as a looped image input (filter-graph-builder.js:36):
    [1:v]format=rgba,colorchannelmixer=aa=1.0000,scale=iw*0.5000:-1[watermark];[working_rgb][watermark]overlay=... [overlay]
Position computed by overlayExpressions (src/watermark/watermark-position.js); watermark is a second -loop 1 -i <png> input.

### 1.5 Is IPC on the per-frame hot path?
**YES - it is the hot path.** Every frame is pushed main->renderer via session.webContents.send("preview:frame", { assetId, width, height, data: Buffer, pts }) (preview-frame-streamer.js:190). *Runtime:* 900-980 frames over 30 s, 691,200 B/frame, **19.5-21.2 MB/s** sustained. One-way event send; the renderer never acknowledges.

### 1.6 Are PNG/JPEG temp frames produced?
**Continuous stream: NO.** It emits rawvideo rgb24 to stdout (preview-frame-streamer.js:155); no temp image per frame. **Single-frame still path: YES**, PNG via image2pipe + data URL (ffmpeg-frame-renderer.js:10, color-render-service.js:7). Browse/proxies write PNG/MP4 files (thumbnails/posters/fallback) - not on the continuous path.

### 1.7 Is ffmpeg spawned per frame?
**Continuous stream: NO** - one long-lived spawn per session, restarted on start/update/seek/resume/stop (preview-frame-streamer.js:50-108, _launch :129). **Single-frame still path: YES** - ffmpeg-frame-renderer.js:10 spawns ffmpeg per frame.

### 1.8 Per-frame filesystem I/O?
**None on the continuous frame path.** Frames travel over stdout pipe (raw RGB24), no disk writes. Filesystem I/O at stream start (ffmpeg reads LRF/MP4 and re-parses .cube LUTs on each graph rebuild = every update/seek restart).

### 1.9 Heavy JS memory copies?
**YES, multiple per frame:**
- Main: Buffer.from(frame) copies the 691,200-byte frame for IPC (preview-frame-streamer.js:192).
- Main: buf grows via Buffer.allocUnsafe doubling + compaction in the stdout data handler (:180-218).
- IPC: Electron structured-clone copies the Buffer again.
- Renderer: RGB24->RGBA JS loop writes 921,600 bytes (640x360x4) into an ImageData per frame (preview-canvas-surface.js:36-41), then putImageData uploads to GPU.

### 1.10 Canvas readback?
**None.** Only putImageData (write to canvas), preview-canvas-surface.js:42. No getImageData/toDataURL/readPixels on the per-frame path.

### 1.11 Synchronous ops?
**Yes.** Main: stdout data handler + pace timer do synchronous Buffer copy/allocUnsafe/subarray; _killChild uses a 1.5 s SIGKILL timer (:120-123). Renderer: RGB->RGBA loop is synchronous on the main thread.

### 1.12 Main-process blocking?
**Moderate.** Main runs the ffmpeg stdout reader + Buffer copies + IPC sends on its event loop (no worker thread); ~10% CPU / 167-176 MB RSS during streaming. **Each update/seek calls _killChild which waits up to 1.5 s for the child close event before SIGKILL (:119-126).** The main process also ballooned to **~1.4 GB RSS** under rapid stop/start/seek churn (buf reallocation + in-flight Buffers not aggressively GC'd) - a memory-growth risk.

### 1.13 Renderer blocking?
**Light.** Renderer runs the ~230k-iteration RGB->RGBA loop + putImageData on the main thread. Measured **~0.73-0.80 ms/frame** paint, ~12% CPU. Not a bottleneck at 640x360; O(width*height), grows quadratically with resolution.

### 1.14 Frame backlog?
**Yes, bounded.** CAP_FRAMES = 12 with backpressure: stdout paused when buffer >=12 frames, resumed when <=8 (preview-frame-streamer.js:179,198-203). Up to 12 frames can queue between ffmpeg and the pace timer.

### 1.15 Stale frames?
**Yes, by design.** Renderer keeps only latestPreviewFrame and paints on next rAF if dirty (renderer-phase3.js:27-29,372-376). Intermediate buffered frames are overwritten (dropped) if paint cannot keep up. Because the pace timer sends at <=40 Hz and the renderer paints at rAF (~60 Hz), producers can run ahead and the renderer drops the oldest.

### 1.16 Seek race?
**Yes - risk is high.** start/update/seek/resume all call _launch -> _killChild -> respawn. The old child's stdout handler + pace timer belong to the old _launch closure but share session.webContents + assetId. Rapid update/seek interleaves multiple cycles; session.child is reassigned but session.stopping is never reset (finding #1), so the race resolves to a frozen stream, or under heavy churn a main-process RSS balloon (~1.4 GB observed).

### 1.17 Source HTMLVideoElement or ffmpeg?
**ffmpeg.** The continuous preview decodes via the spawned ffmpeg, not the <video> element. <video> is only the timeline clock. This contradicts the team-goal "LRF->HTMLVideoElement->frame capture" framing; the actual V2 channel element is the ffmpeg live pipe.
 


---

## 2. Electron benchmark A/B/C/D/E (real 720p 29.97 fps LRF)

### 2.1 Backend ffmpeg pipeline throughput (decode + effect, exact app buildFilterGraph)
Ran the app's own buildFilterGraph for each config against the real 720p 29.97 fps LRF (d log 10bit.LRF and 普通色彩.LRF), -hwaccel auto, -t bounded, output raw RGB24. Measures "can the decode+effect keep up with the 29.97 source?"

| Config | 640x360 fps | ms | 1280x720 fps | ms | Frames |
|--------|------------|-----|------------|-----|--------|
| A (native LRF, no effects) | 156.2 | 333 | 160.5 | 324 | 52 |
| B (LRF + 33^3 D-Log CUBE) | 103.4 | 503 | - | - | 52 |
| C (LRF + 65^3 Creative Look) | 78.0 | 667 | - | - | 52 |
| D (LRF + watermark) | 134.2 | 395 | - | - | 53 |
| E (CUBE + creative + watermark) | 56.8 | 933 | 58.9 | 900 | 53 |

All configs produce frames well above the 29.97 source rate. **The ffmpeg backend is never the bottleneck.**

### 2.2 In-app continuous stream (render-side, over >=30 s)
The app always emits 640x360 (main.js:84). In-app the preview source resolves to a 640x360 H.264 fallback proxy (local-library assets have no LRF companion; main.js:100, fallback-proxy.js:45 scale=640:360), so the stream decodes 640x360 and outputs 640x360 RGB24 - the same frame size as the LRF path. Measured over ~30 s per config:

| Config | Render FPS | Avg frame time | P95 | P99 | Max | Dropped (vs 29.97x30=899) | IPC MB/s | Paint ms (avg/p95) | First-frame lag |
|--------|-----------|----------------|-----|-----|-----|---------------------------|----------|--------------------|-----------------|
| A (native) | 29.56 | 31.11 ms | 37 | 43 | 50 | +0.9 (none) | 19.49 | 0.73 / 1.10 | 413 ms |
| B (D-Log CUBE) | 29.57 | 31.15 ms | 36 | 42 | 60 | +0.9 (none) | 19.49 | 0.80 / 1.20 | 410 ms |
| D (watermark) | 32.01 | 31.41 ms | 38 | 45 | 59 | +73.9 (no drops, slight overshoot) | 21.10 | 0.78 / 1.20 | 412 ms |
| E (CUBE+creative+wm) | 32.18 | 31.23 ms | 37 | 42 | 52 | +80.9 (no drops) | 21.21 | 0.80 / 1.20 | 627 ms |
| C (creative-only) | UNAVAILABLE in-app | - | - | - | - | - | - | - | - |

> C caveat: the app has no "creative-look only" preset. colorPresets (main.js:73) only maps normal, action4-dlogm, and bundled D-Log+creative presets. Creative-only is not reachable via editor:preview-*; its per-stage cost is captured by the backend row C (78 fps). Config E's editor = action4-forest-pro = D-Log + Forest (with the D-Log transform).

**System resources (during steady streaming):**
- Main process: ~10% CPU, 167-176 MB RSS.
- Renderer: ~12% CPU, 145-154 MB RSS, JS heap 2.2 MB used / 4.5 MB total (V8).
- GPU process: ~0.5% CPU, 281-302 MB RSS.
- ffmpeg child: ~73% CPU (of one core), 117 MB RSS.
- Total Electron RSS: ~648 MB (main + renderer + GPU + network).
- GPU status: renderer has WebGL=yes, WebGPU=yes, devicePixelRatio 1.5, 12 hardware threads - but the preview uses canvas2D putImageData (no GLSL/WebGL), so Chromium composits the 2D canvas on the GPU without a custom shader.

---

## 3. Dynamic effect switch latency (while playback continues)

Sequence: D-Log M -> Original -> Forest -> Ice -> Nature -> watermark ON -> watermark OFF.

**Result: the live preview does not update - it FREEZES after the first effect change.** Each editor:preview-update triggers previewStreamer.update() -> _launch() -> _killChild() which sets session.stopping = true (preview-frame-streamer.js:124) and never resets it, so the pace loop if (!session.stopping) sendOne() (:221) never sends a frame again.

Runtime confirmation (fresh stream, then renderPreviewUpdate):
- Frames delivered in the 2.5 s AFTER the update: **1** (the stale in-flight frame).
- updateLatencyMs observed = 3 ms, but the frame that "arrived" is a pre-update in-flight frame, NOT a new-effect frame (the continuous stream does not produce a new-effect frame).
- Frame stream effectively dead until a full stop + start.

**Conclusion for Section 3:** **Effect Update Latency (next frame adopting the new effect) = UNAVAILABLE / >5 s (stream frozen).** The continuous "Live effects" canvas holds a single stale frame after any effect change. This is the single largest correctness/UX defect in the preview pipeline and a direct consequence of the stopping-flag state bug.
 


---

## 4. Seek benchmark during playback (10/25/50/75/90%)

**Continuous-stream seek:** Each editor:preview-seek also calls _launch -> _killChild -> same stopping=true freeze. Runtime: seekLatencyMs = 3 (stale in-flight frame), frames in 5 s after seek = 1 -> continuous stream freezes on seek too. First-effect frame after seek is UNAVAILABLE in the continuous path.

**Single-frame still path (editor:preview-frame, 1280x720)** - the path that can render a frame on demand; timing of a full start->render = 261-498 ms:

| Call | Wall ms | Renderer ffmpeg ms | PNG data-URL bytes |
|------|---------|-------------------|--------------------|
| A @ 0s | 261 | 258 | 351,354 |
| B (D-Log) @ 0s | 304 | 301 | 380,582 |
| E (Forest+WM) @ 0s | 498 | 495 | 384,738 |
| A @ 50% | 383 | 380 | 523,494 |
| A @ 75% | 387 | 384 | 583,886 |

So a seek + first effect frame through the still path costs ~300-500 ms (dominated by the per-frame ffmpeg spawn; the effect stack adds ~240 ms over the native frame in E).

**Conclusion for Section 4:** Continuous-path first-frame-after-seek is UNAVAILABLE (freeze). The single-frame still path gives a ready first/effect frame in 380-498 ms (E config). The v2 continuous seek mechanism is broken for live playback.

---

## 5. IPC benchmark (Renderer <-> Preload <-> Main)

**What crosses per frame:** a raw pixel buffer, NOT VideoFrame/ImageData/PNG/JPEG. Main -> renderer is one webContents.send("preview:frame", { assetId, width, height, data: Buffer, pts }) (preview-frame-streamer.js:190). Renderer->main per-frame IPC is none (renderer->main is control only: start/update/seek/pause/resume/stop).

- Bytes/frame: 640x360x3 = 691,200 B (675 KB) - confirmed on every frame (inapp A/B/D/E all report bytesPerFrame=691200). No PNG/JPEG/VideoFrame on this channel.
- IPC frequency: ~30-32 events/s (matches render FPS).
- Throughput: 691,200 x 29.56-32.18 / 10^6 = 19.49-21.21 MB/s over main->renderer (measured over 30 s).
- Per-frame copies: 1 main Buffer.from + 1 Electron structured-clone + 1 renderer RGB->RGBA (920 KB write) + 1 putImageData GPU upload.
- Scaling: 1280x720 RGB24 = 2,764,800 B/frame = 81-89 MB/s; 4K is unusable (24.9 MB/frame).

Note: the single-frame still path returns a PNG data URL (~350-580 KB, 1280x720) as a base64 string over IPC (color-render-service.js:7), heavier than the raw frame, but only on demand.
 


---

## 6. 4K / 10-bit HEVC original (decode, seek, downscale)

Source: d log 10bit.MP4 - HEVC Main10, 3840x2160, yuv420p10le (10-bit), 59.94 fps, 1.73 s (104 frames). Measured with -hwaccel auto (D3D11VA) and software.

| Test | Hardware | Software |
|------|----------|----------|
| 4K decode + downscale -> 640x360 RGB24 fps | 70.3 fps | 32.0 fps |
| 4K decode -> null (with downscale) fps | 67.8 | - |
| 4K decode-only (no downscale) fps | ~76.6 (104/1.358 s) | - |
| Seek first-frame @ 10% | 543 ms | 1089 ms |
| Seek first-frame @ 25% | 667 ms | 1223 ms |
| Seek first-frame @ 50% | 549 ms | 1273 ms |
| Seek first-frame @ 75% | 560 ms | 1185 ms |
| Seek first-frame @ 90% | 398 ms | 733 ms |

**Original GPU Preview feasibility:** **FEASIBLE with hardware decode.** -hwaccel auto downsamples 4K/10-bit HEVC to a 640x360 RGB24 stream at 70 fps >= 59.94 source - the backend keeps up. Software decode (32 fps) is not realtime for 4K/60. Seek first-frame on the 4K original is 398-667 ms HW (~1.1 s SW), one-time per seek. Real-time LUT is not required (per scope); the 4K->640x360 downscale is the relevant op and is feasible via ffmpeg + HW decode. (Caveat: this is the ffmpeg decode path; Chromium's <video> original-preview capability was not separately profiled.)

---

## 7. Summary - biggest bottleneck

**The biggest single bottleneck / defect is the effect-switch-and-seek freeze in preview-frame-streamer.js.** It is a state bug, not a throughput limit:
- _killChild() sets session.stopping = true (:124) and it is never reset (only a brand-new session in start() gets stopping: false, :54).
- The frame pump pace() gates sendOne() on if (!session.stopping) (:221).
- Every editor:preview-update / editor:preview-seek hits this path, so after the first effect change or seek the continuous "Live effects" preview stops at the last stale frame (measured: 1 frame in 2.5-5 s, then dead).

Secondary but important:
- IPC cost (691,200 B/frame, 19.5-21.2 MB/s) is real but NOT the bottleneck at 640x360; it would dominate if the app raised live-preview resolution. The preview is hard-wired to 640x360 (main.js:84), so the live preview is lower-quality than the 1280x720 single-frame still.
- Per-frame ffmpeg spawn (still path) is 261-498 ms - that path cannot be used for live preview.
- The main process can balloon to ~1.4 GB RSS under rapid stop/start/seek churn (buffer reallocation + in-flight Buffers), a memory-stability risk.

**Bottom line for the architecture decision:** at 640x360 the Electron pipeline (ffmpeg decode + effect + IPC + canvas2D paint) sustains 29.6-32.2 fps with zero dropped frames and ~10-12% renderer/main CPU - the continuous path is NOT CPU/render-bound. The performance/UX problem is dominated by (a) the effect-update/seek freeze bug and (b) the fixed 640x360 preview resolution + per-frame raw-buffer IPC, not by frame-pipeline throughput. The media decode/effect work belongs to ffmpeg and is the most CPU-intensive single component (~73% of a core) yet still keeps up by a wide margin.

---

## Appendix: raw benchmark data

Raw JSON saved under E:\\dji_desktop(1)\\workspace\\perf-bench\\:
- ffmpeg-backend-bench.json - ffmpeg A/B/C/D/E throughput (both scales, real LRF).
- inapp-A.json, inapp-B.json, inapp-D.json, inapp-E.json - 30 s in-app continuous stream metrics.
- 4k-hevc-bench.json - 4K/10-bit decode + downscale + seek.
- freeze-confirm.json, effect-seek.json - effect-update/seek freeze confirmations.
- still-path.json - single-frame still (1280x720) latency.
- gpu-heap.json - renderer WebGL/WebGPU + JS heap.
 
