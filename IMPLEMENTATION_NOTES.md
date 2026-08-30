# IMPLEMENTATION_NOTES — Continuous Real-time Preview Renderer (Phase 4.5)

Task t4 (engineer) — implements the **continuous** real-time Preview Renderer per
the approved architecture in `REALTIME_PREVIEW_ARCH.md` (Option B).

## What was built

A long-lived **ffmpeg live filter pipe → <canvas>** that streams effect-applied
RGB24 frames to the renderer, reusing the export graph verbatim so **Preview ==
Export by construction**.

Pipeline (edit mode, playback running):
`LRF/original -> playback -> EffectGraph -> Color -> Creative Look -> Watermark -> Geometry -> <canvas>`

The hidden `<video id="preview-video">` remains the **master clock** (play / pause /
seek / trim clamp). The opaque `#preview-canvas` is layered on top in edit mode and
paints effect frames at ~the source frame rate, so the on-screen effect follows
playback frame-by-frame instead of being a single frozen still.

## Files changed

| File | Change |
|---|---|
| `src/renderers/preview-frame-streamer.js` | **NEW** — main-side session manager: spawns one long-lived ffmpeg per asset applying `buildFilterGraph`, reassembles raw RGB24 frames, paces delivery to the source rate and streams them via IPC. Lifecycle: start/update/seek/pause/resume/stop/shutdown. |
| `src/preload/preload.js` | Added `renderPreviewStart/Update/Seek/Pause/Resume/Stop` + `onPreviewFrame` on `window.djiMedia`. |
| `src/main/main.js` | Require + instantiate `PreviewFrameStreamer` (shares the official LUT registry + cacheRoot), register `editor:preview-*` IPC handlers, shutdown on quit. |
| `src/renderer/renderer-phase3.js` | `edit()` starts the live session instead of rendering a still; `scheduleEdit()` hot-swaps the live graph (debounced) instead of re-rendering a still; play button stays in edit mode; `browse()`/seek/trim/clamp/asset-switch stop or re-seek the pipe; `onPreviewFrame` paints the canvas. |
| `src/renderer/preview-canvas-surface.js` | **NEW** — renderer-side RGB24 → RGBA → `putImageData` painter for `#preview-canvas` (exposed as `window.__PreviewCanvasSurface`). No GLSL / color re-derivation. |
| `src/renderer/index.html` | Added `<canvas id="preview-canvas" hidden>` to the shell + the `preview-canvas-surface.js` script tag. |
| `src/renderer/styles.css` | `#preview-canvas` shares the absolute-fill surface rule; add `canvas[hidden]` to the hide rule; opaque shell background. |

## Requirements → how each is met

- **Continuous frame-by-frame effects during edit playback:** the long-lived pipe
  yields a new effect frame per pace tick; the canvas advances with the clip.
- **Creative Look / D-Log M→Rec.709 continuous:** both are part of the exact
  `graphForEditor` → `buildFilterGraph` chain, applied every frame.
- **Normal color plays the effect frame flow:** normal preset is the empty graph; the
  pipe still streams the (identity) effect frames continuously.
- **Watermark / Color / Effect act as continuous processing:** they are in the graph,
  re-applied to every frame, not a single-frame render.
- **Play button in edit mode keeps playback running WITH effects; toggling to browse
  still allowed:** play toggles the video clock (→ pipe resume/pause); opening another
  asset / `browse()` returns to browse and stops the pipe.
- **Smooth (no per-frame heavy sync; debounce only for params):** the 130 ms debounce
  is used only for control changes (`renderPreviewUpdate`/still path); the playback
  loop is a self-contained paced pipe (never gated by the debounce).
- **Reuses verified math/graph:** `buildFilterGraph` verbatim (cube LUTs, watermark
  overlay, geometry). No color/geometry re-implementation.
- **Preserved existing behaviour:** zoom/fit/rotation (the canvas is inside
  `.shell-content` so it zooms with the video), poster occlusion fix, no-LRF fallback
  (streamer reuses `LrfPreviewSourceResolver` + `ensureFallbackProxy`), D-Log detection
  (unchanged), 92/92 tests green.

## Pacing (and the Windows timer caveat)

The arch suggested `-re` or "renderer drops frames". Empirically on this box:
- `-re` alone gives **~4× real-time**, not 1× (it does not fully slow the pipe; the
  pipe would finish the clip early and the canvas would freeze while the clock plays).
- `setTimeout` on Windows quantizes to **~15.6 ms**, so a 33 ms interval fires ~22 fps.

So the streamer uses a **single lightweight pace timer** (clamped to the ~31 ms bucket
→ ~32 fps) that sends one buffered frame per tick from a bounded buffer, plus **coarse
backpressure** (pauses ffmpeg's stdout when ~12 frames are buffered, resumes when it
drains). This keeps ffmpeg at real-time (prevents finish-early) and delivers a smooth
~32 fps, matching the ~29.97 fps clock. Measured steady ~32 fps on a 30 s synthetic
clip with the full D-Log M + Forest Pro + watermark graph.

## Divergences from REALTIME_PREVIEW_ARCH.md (explicit)

1. **Live canvas delivered at 640×360** (recommended: 1280×720, optional 640×360).
   Chosen for bounded IPC bandwidth/memory and because 720p delivery read-latency
   dropped the rate below the clock. The **color/geometry math is applied at full source
   resolution before the final downscale** (scale is the last graph filter), so
   Preview == Export colour is unchanged; the single-frame still (`editor:preview-frame`)
   remains 1280×720. For arch §7 check 6, the still should be downscaled for comparison.
2. **`renderPreviewResume` / `renderPreviewUpdate` / `renderPreviewPause` also carry
   the clock position (`timelineSeconds`).** The arch signatures omitted it, but the
   renderer owns the `<video>` clock and must tell the pipe where to re-seek on
   resume/update so the effect stays aligned. Consistent with arch §5.6 (§ position is
   only the read cursor, main.js:93 formula).
3. **Added `-t` bound** so the pipe stops at the clip's `sourceOut` (trim) instead of
   playing to source EOF — mirrors export's `-t`. The arch did not specify this.
4. **Pacing** implemented via a pace timer + coarse backpressure instead of purely `-re`
   (which did not give 1× on this machine). Same intent as arch §8.

## Known risks / notes

- **Buffering on short clips:** the pipe decodes the clip fast (the graph runs ~600 fps
  measured) and buffers the frames (bounded by `CAP_FRAMES=12` via backpressure), then
  drains at the pace rate; for the bundled short test clips the buffer stays small.
- **Trim/speed read-cursor quirk:** `_mapSeconds` reuses the existing main.js:93 formula
  (`timelineSeconds * playbackRate + sourceInUs/1e6`); for the default (speed 1, no trim)
  it is exact. For non-default speed/trim the pre-existing formula is reused verbatim for
  consistency with the single-frame still (any quirk is pre-existing, not introduced).
- **Canvas aspect:** the live canvas fills the shell (no `object-fit` on <canvas>), so a
  letterboxed portrait clip may appear slightly stretched vs. the browse video. Minor and
  confined to edit mode; matches the arch's "canvas covers video" model.
- **`-re` removed** from the live pipe (it gave 4×, not 1×); backpressure handles pacing.
- **Test suite:** `npm test` → **92 tests, 92 pass** (no new tests added; unchanged from
  baseline). The renderer wiring is DOM-only (not exercised by the node test runner).

## Verification performed

- ffmpeg live pipe probed against `d log 10bit.LRF` and a 30 s synthetic clip: frame size
  correct, graph valid, ~32 fps steady delivery, pipe stays alive (does not finish early).
- `node --check` on all modified JS files: clean.
- `npm test`: 92/92.
