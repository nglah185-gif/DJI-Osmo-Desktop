# REALTIME_PREVIEW_ARCH

> **Status:** Decision-ready architecture proposal (Phase 4.5). **STOP after this document — implement nothing.**
> **Goal it serves:** a truly *continuous* real-time Preview Renderer for DJI Osmo Desktop V2:
> `LRF -> continuous playback -> EffectGraph -> Color -> Creative Look -> Watermark -> Geometry -> realtime display`,
> with the on-screen effect following playback frame-by-frame (never a frozen still).
> All file:line references are relative to `src/` under the `dji-osmo-desktop-v2` package root.
> Measurements were taken against real bundled media (`dji-test-media/普通色彩.LRF`, `dji-test-media/d log 10bit.LRF`).

---

## 0. Executive summary (recommendation up-front)

**Recommend Option B — a long-lived `ffmpeg` live filter pipe that streams effect-applied raw frames to a `<canvas>`.**
It is the only option that **reuses the already-verified export filter graph verbatim**, which guarantees
Preview == Export pixel behavior, and it is empirically proven fast enough: the worst-case graph
(D-Log M→Rec.709 CUBE + a Creative Look CUBE + eq + watermark overlay) measured **≈600 fps (23.5× realtime)**
on the real 1280×720 LRF proxy. Option A (WebGL) is the higher-risk, higher-reward alternative; Option C (CSS)
is **rejected** because CSS filters cannot express 3D CUBE LUTs or the log→Rec.709 curve.

---

## 1. EXACT current single-frame flow (the root cause of the phase 4.5 pain)

### 1.1 The browse path (no effects)
`browse()` (`renderer/renderer-phase3.js:217`) hides `#color-preview` (`image.hidden = true`) and shows the
native `<video id="preview-video">` (`video.hidden = false`), resolves a preview URL via
`api.getPreviewUrl(assetId)` (`renderer-phase3.js:228`, → IPC `media:preview-url`, `preload/preload.js:6`,
handler `main/main.js:88`), and plays the LRF/original RAW video **with no effects**.

### 1.2 The edit path (one static frame)
When the user changes an editor control, `scheduleEdit()` (`renderer-phase3.js:25`) debounces 130 ms, then goes
to `edit()` (`renderer-phase3.js:248`) via `setMode("edit")` (`line 146`):

1. `edit()` (`renderer-phase3.js:249`) calls `video.pause()`, `video.hidden = true`, `image.hidden = false`.
2. It builds the effect state: `editorFromControls()` (`renderer-phase3.js:142`) → `state.editor` (`line 252`).
3. It calls `api.renderEditPreview({ assetId, timelineSeconds: video.currentTime || 0, editor })`
   (`renderer-phase3.js:252`).

### 1.3 IPC → main → graph
- `preload/preload.js:11`: `renderEditPreview: request => ipcRenderer.invoke("editor:preview-frame", request)`.
- Handler `main/main.js:93` `editor:preview-frame`:
  - Resolves source: `previewResolver.resolve(asset)` (`preview/lrf-preview-source-resolver.js:1-4`) → the LRF
    path, else a fallback proxy. So the *preview input is the low-res LRF*.
  - Builds the graph: `graphForEditor(args.editor)` (`main/main.js:73`).
  - Maps timeline → source seconds (`main/main.js:93`):
    `seconds = timelineSeconds * clip.playbackRate + clip.sourceInUs / 1e6`.
  - Calls `colorRenderService.renderPreviewFrame(sourcePath, seconds, graph, 1280, 720)`.

### 1.4 The frame renderer (ffmpeg, one-shot)
- `renderers/color-render-service.js:7`: `renderPreviewFrame(...)` → `frameRenderer.render(...)`,
  returns `{ dataUrl: "data:image/png;base64,...", elapsedMs, filterGraph, generatedLuts }`.
- `renderers/ffmpeg-frame-renderer.js:6-14` `render()`:
  - `buildFilterGraph(...)` (`renderers/filter-graph-builder.js:1-42`) compiles the SAME -vf graph used by export.
  - Adds a preview scale by replacing `format=rgb24[outv]` with `format=rgb24,scale=1280:720[outv]`
    (`ffmpeg-frame-renderer.js:10`).
  - Runs **one** ffmpeg invocation that decodes ONE frame:
    `ffmpeg -v error -hwaccel auto -ss <seconds> -i <LRF> <inputs> -filter_complex <graph> -map [outv]
    -frames:v 1 -f image2pipe -vcodec png pipe:1` (`ffmpeg-frame-renderer.js:10`).
  - `run()` (`ffmpeg-frame-renderer.js:16`) spawns a child and captures stdout to a PNG buffer.

### 1.5 Result to <img>
Back in `edit()`: `image.src = r.dataUrl` (`renderer-phase3.js:252`) sets `#color-preview` to that single PNG.

### 1.6 Why this is the root cause
Every editor change triggers a fresh **process spawn + `-ss` seek + decode + PNG encode**, then paints a *single still*.
That is hundreds of ms per frame — it cannot reach 30 fps, and `video` is paused/hidden, so there is **no continuous
playback of the effect**. The effect only ever appears on an isolated still, never during motion.

### 1.7 Mode matrix (current behavior)
| Mode | Surface | Source | Effects | Play button (`renderer-phase3.js:284`) |
|---|---|---|---|---|
| browse | `#preview-video` | LRF/original | none | play/pause the raw video |
| edit | `#color-preview` <img> | ffmpeg single frame | applied, static | **flips to `setMode("browse")` → raw video, effects lost** |

The play button handler (`renderer-phase3.js:284`) is the explicit phase-4.5 bug: in edit mode it reverts to browse
(raw, no effects) instead of continuing to play with effects.

---

## 2. Source-precondition facts (measured, real media)

| Property | LRF proxy (preview source) | Original (export source) |
|---|---|---|
| Codec | H.264 | HEVC |
| Resolution | **1280×720** | 3840×2160 |
| Pixel format | yuv420p | yuv420p10le |
| Frame rate | 29.97 fps | 59.94 fps |

- The preview path already renders at exactly 1280×720 (`main/main.js:93`), **matching the LRF native size**.
- **Throughput (worst case, measured):** running the full preview graph for a D-Log M clip
  (D-Log M→Rec.709 CUBE + Forest Pro Creative Look CUBE + `eq` + watermark `overlay`) on
  `d log 10bit.LRF` (720p) with `-f null - -benchmark`: `frame= 240 ... speed=23.5x elapsed=0:00:00.40`
  → **≈600 frames/sec ≈ 23.5× realtime**. At 30 fps that is ≈20× headroom; even the heavy case is far from the limit.
- **Raw pipe bandwidth:** 720p RGB24 = 1280×720×3 ≈ **2.64 MB/frame** → ≈79 MB/s at 30 fps.
  Downscaling the preview canvas to 640×360 → ≈0.69 MB/frame → ≈21 MB/s (see §8).

---

## 3. Candidate continuous-architecture evaluation

### Option A — WebGL video-texture shader compositor
Upload the playing `<video>` to a GL texture each rAF and run LUT3D (from the existing CUBE files), color matrix,
creative look, watermark overlay and geometry in a fragment shader.

- **Realtime:** true, frame-accurate, GPU. Smooth.
- **Reuses existing math/graph:** weak. There is a JS LUT sampler (`color/lut-engine.js:1-2`, `color/cube-lut.js:24-30`
  trilinear `sampleCube`) but it must be **ported to GLSL**. The geometry (crop/transpose/hflip/vflip,
  `filter-graph-builder.js:8-15`) and watermark mix (`colorchannelmixer`, `overlay` expressions,
  `filter-graph-builder.js:36`) also must be re-implemented in shader code and proven pixel-identical to export.
- **Risk:** high. Any color/geometry divergence between the live GLSL and the ffmpeg export chain silently breaks the
  core promise of a color tool (preview == delivered file). Must also load each CUBE as a 3D texture and match ffmpeg's
  trilinear+normalization exactly.
- **Effort:** large (new compositor, shader pipeline, LUT3D upload, blending, geometry) — significant new code.

### Option B — ffmpeg live filter pipe → <canvas>  (RECOMMENDED)
Spawn **one** long-lived `ffmpeg` decoding the LRF source, applying the **exact** `buildFilterGraph` output that
export already produces (cube LUTs, color, watermark, geometry), and stream raw RGB24 frames to a pipe; main relays
them to a `<canvas>` which paints each frame via rAF.

- **Reuses existing math/graph:** **strongest.** It reuses `buildFilterGraph` (`filter-graph-builder.js:1-42`)
  verbatim — the same string used by the frame renderer (`ffmpeg-frame-renderer.js:10`) and export
  (`ffmpeg-export-renderer.js:11`). Preview and Export are guaranteed consistent by construction.
- **Throughput:** measured **≈600 fps / 23.5× realtime** (§2) — comfortably above 30 fps.
- **Realtime:** yes, continuous frames delivered to a canvas and advanced with the playback clock.
- **Existing precedent:** `run()` already captures ffmpeg stdout buffers (`ffmpeg-frame-renderer.js:16`), so the
  "read the pipe" pattern is proven here; export already applies the same graph for whole-clip video
  (`ffmpeg-export-renderer.js:12`).
- **Risk:** moderate, but bounded and solvable — mostly **frame-delivery bandwidth + sync** (§5, §8),
  not whether the color pipeline can keep up.
- **Effort:** moderate. New streaming session module + a canvas + a few IPC channels; no GLSL, no color re-derivation.

### Option C — CSS filter + overlay compositing on the native <video>
Apply `filter` / an overlay `<img>` / `transform` continuously while `<video>` plays.

- Smooth and near-zero code, but **cannot express arbitrary 3D CUBE LUTs** and **cannot do the D-Log M→Rec.709 log
  curve** (it is a nonlinear 3D LUT, not a contrast/saturation matrix). `filter: saturate/contrast/brightness` cannot
  reproduce the Creative Look LUTs either.
- **Rejected.** It would fail requirement (2) — Creative Look and D-Log M→Rec.709 must both be live.

### The comparison
| Criterion | A WebGL | B ffmpeg pipe | C CSS |
|---|---|---|---|
| Continuous frame-by-frame effects | ✅ | ✅ | ⚠️ (only filter-style) |
| D-Log M→Rec.709 live | ✅ (port LUT to GLSL) | ✅ (reuses CUBE) | ❌ |
| Creative Look CUBE live | ✅ (port to GLSL) | ✅ (reuses CUBE) | ❌ |
| Watermark + geometry live | ✅ (port) | ✅ (reuses graph) | ⚠️ partially |
| Preview == Export consistency | ⚠️ must re-derive & verify | ✅ **by construction** | ❌ |
| Reuses existing math/graph | ❌ | ✅✅ | ❌ |
| Risk / effort | high / large | moderate / moderate | low but insufficient |
| Empirical headroom | n/a | **≈20×** | n/a |

---

## 4. RECOMMENDATION

**Adopt Option B — continuous ffmpeg live filter pipe → `<canvas>`.**

Rationale (maps to the stated requirements):
1. **Continuous playback of effects frame-by-frame:** the pipe yields a new effect-applied frame per display tick;
   the on-screen canvas advances with the clip, never a still.
2. **Creative Look + D-Log M→Rec.709 + normal + watermark + geometry all live:** the exact graph
   (`graphForEditor` → `buildFilterGraph`) already contains all of them (`filter-graph-builder.js:19-36`);
   normal color is the empty graph, D-Log M is the technical LUT, Creative Look is the style LUT, watermark is
   the overlay, geometry is crop/transpose/flip.
3. **Smooth:** measured ≈600 fps (23.5× realtime) on the real 720p LRF, far above the 30 fps target.
4. **Reuses existing math/graph:** it reuses `buildFilterGraph` verbatim, so preview == export by construction —
   the hardest correctness property for a color tool is met with zero re-derivation risk.

**Alternative to keep in mind:** if later the pipe-delivery bandwidth or the per-seek restart latency becomes the real
bottleneck, migrate to Option A (WebGL) and reuse `color/lut-engine.js` + `color/cube-lut.js` semantics as the
reference for the GLSL port. Do **not** choose C.

---

## 5. Exact integration points

### 5.1 DOM — `renderer/index.html`
Inside the `.video-shell > .shell-content` block (`renderer/index.html:28`), after the two `<img>` surfaces, add a
canvas as the live effect surface (vs. the still-based `<img id="color-preview">`):
```html
<video id="preview-video" playsinline preload="metadata"></video>
<img id="poster-preview" alt="" hidden>
<img id="color-preview" alt="" hidden>          <!-- kept for fallback / still mode -->
<canvas id="preview-canvas" hidden></canvas>    <!-- NEW: continuous effect surface -->
```
`#preview-canvas` sits on top of `#preview-video` and covers it (opaque frames), while the `<video>` remains the
master clock (play/pause/seek/scrub + `timeupdate` + trim clamp at `renderer-phase3.js:281`).

### 5.2 Preload — `preload/preload.js`
Add streaming IPC alongside `renderEditPreview` (`preload/preload.js:11`):
```js
renderPreviewStart:  p => ipcRenderer.invoke("editor:preview-start",  p),  // { assetId, editor }
renderPreviewUpdate: p => ipcRenderer.invoke("editor:preview-update", p),  // { assetId, editor } hot-swap graph
renderPreviewSeek:   p => ipcRenderer.invoke("editor:preview-seek",   p),  // { assetId, timelineSeconds }
renderPreviewPause:  () => ipcRenderer.invoke("editor:preview-pause"),
renderPreviewResume: () => ipcRenderer.invoke("editor:preview-resume"),
renderPreviewStop:   p => ipcRenderer.invoke("editor:preview-stop",   p),  // { assetId }
onPreviewFrame: cb => { const l = (_e, f) => cb(f); ipcRenderer.on("preview:frame", l);
                          return () => ipcRenderer.removeListener("preview:frame", l); },
```

### 5.3 Main — `main/main.js` + a new session module
**New module `src/renderers/preview-frame-streamer.js`** (encapsulates lifecycle so `main.js` stays lean) with a
session manager keyed by `assetId`:
- `start({ assetId, sourcePath, editor, graph, width, height })`: builds the graph via `buildFilterGraph`, spawns
  the long-lived process and streams frames:
  `ffmpeg -v error -hwaccel auto -ss <clip.sourceInUs/1e6> -i <sourcePath> <inputs> -filter_complex <graph>
  -map [outv] -f rawvideo -pix_fmt rgb24 -`
  where `<graph>` is `buildFilterGraph(...)` output with `format=rgb24[outv]` replaced by
  `format=rgb24,scale=<W>:<H>[outv]` (mirrors the existing scale trick at `ffmpeg-frame-renderer.js:10`).
- `update(editor, graph)`: restart the process if the graph changed (color/geometry/watermark).
- `seek(timelineSeconds)`: kill and restart at the new seek point — reuse the mapping at `main/main.js:93`
  (`seconds = timelineSeconds * clip.playbackRate + clip.sourceInUs/1e6`).
- `pause()` / `resume()`: kill on pause, restart at the current source position on resume (SIGSTOP is not portable).
- `stop()`: kill the child and delete the session.
- Frame reassembly: read `child.stdout` into fixed `width*height*3` RGB24 buffers; on each complete frame send
  `webContents.send("preview:frame", { assetId, width, height, data: <Uint8Array>, pts })`.

In `main/main.js`, register the handlers near the existing `editor:preview-frame` (`main/main.js:93`), reusing
`getAssetAny`, `previewResolver.resolve`, `graphForEditor`. Keep the existing `editor:preview-frame` handler for the
still/fallback path, and the existing export handlers (`main/main.js:94-95`) unchanged.

Pacing/backpressure: use `-re` (read at native rate) OR let the renderer drop frames that lag the video clock; do not
allow the pipe to overrun (see §8).

### 5.4 Renderer — `renderer/renderer-phase3.js`
- Replace the still render in `edit()` (`renderer-phase3.js:248`) with a session start: ensure `#preview-canvas`
  is visible (and `video`/`img` hidden), call `api.renderPreviewStart({ assetId, editor })`, and start a rAF
  (or `requestVideoFrameCallback`) loop that paints each `onPreviewFrame` buffer into `#preview-canvas`.
- Change `scheduleEdit()` (`renderer-phase3.js:25`): instead of re-rendering a still, debounce into
  `api.renderPreviewUpdate(editor)` so a control change **hot-swaps the live graph while playback keeps running**.
- **Fix the play button** (`renderer-phase3.js:284`): in edit mode call `renderPreviewResume()` + `video.play()`
  (clock) instead of `setMode("browse")`; pause → `renderPreviewPause()`.
- **Wire seeks** (`applySeek` `renderer-phase3.js:256`; timeline seek `renderer-phase3.js:336`): in edit mode call
  `api.renderPreviewSeek(seconds)` so the pipe re-seeks and the canvas continues.
- **Asset lifecycle:** on `open(id)` (`renderer-phase3.js:120`) and on asset switch, call `renderPreviewStop(assetId)`
  for the previous clip.
- `editorFromControls()` (`renderer-phase3.js:142`) stays the canonical source of the effect state (§5.6).

### 5.5 New modules
- `src/renderers/preview-frame-streamer.js` — ffmpeg pipe lifecycle + frame reassembly (main side).
- Optionally `src/renderer/preview-canvas-surface.js` — paints incoming frames into `#preview-canvas` and paces by
  the video clock (renderer side). No GLSL, no color-math rewrite.

### 5.6 Effect-state data contract (editor → renderer params)
The effect state is **position-independent** over the clip range — this is the enabler for continuous preview:
```ts
interface EditorState {
  clip: { sourceInUs: number; sourceOutUs: number; playbackRate: number };
  colorPreset: "normal" | "action4-dlogm" | "action4-forest-pro" | "action4-ice-pro" | "action4-nature-pro";
  displayTransform: { rotation: number; crop: {left,top,right,bottom}; flipHorizontal: boolean; flipVertical: boolean };
  watermark: { id: string; enabled: boolean; scale: number; opacity: number; position: {x:number;y:number} };
}
```
Main maps it with the existing `graphForEditor(editor)` (`main/main.js:73`): `colorPreset` → technical LUT
(selection at `main/main.js:72`) built via `action4DlogGraph(creative)` (`color/pipeline.js:14-15`) which sets
`colorTransform.enabled = true` + `styleStack` for a Creative Look; `displayTransform` → geometry
(`filter-graph-builder.js:6-15`); `watermark` → overlay (`filter-graph-builder.js:36`).

**For a moving playback position:** the position is NOT passed into the color graph. It only selects the read cursor:
- Continuous play: the pipe advances sequentially through `[sourceInUs, sourceOutUs]`; the visible frame follows.
- Explicit seek: `renderPreviewSeek(timelineSeconds)` → main recomputes `seconds` and restarts the pipe at that point
  (`main/main.js:93` formula).
- Speed/trim: only affects `sourceInUs`/`sourceOutUs`/`playbackRate`, which feed the input `-ss`/`-t`/speed
  (as export does at `ffmpeg-export-renderer.js:11-12`), not the graph.

---

## 6. preview-mode interplay

- **Edit mode must show continuous effect output.** `#preview-canvas` (effects) is the edit-mode surface; the raw
  `<video>` is the clock underneath. `edit()` (`renderer-phase3.js:248`) starts the effect session and keeps it
  running; the play button (`renderer-phase3.js:284`) **resumes the effect stream**, not `browse()`.
- **The play button must not revert to raw browse.** Change `renderer-phase3.js:284`:
```js
$("play-button").addEventListener("click", () => {
  if (state.mode === "edit") {
    if (video.paused) { video.play(); api.renderPreviewResume(); }
    else { video.pause(); api.renderPreviewPause(); }
    return;
  }
  video.paused ? video.play() : video.pause();
});
```
- `browse()` remains the no-effects playback for library previewing, and `setMode` (`renderer-phase3.js:146`) still
  switches surfaces; in edit mode the canvas replaces the still `<img>`.

---

## 7. Verification strategy for the tester (CDP pixel checks)

Prove the effect **follows playback frame-by-frame** rather than being a still:

1. **Live, not frozen:** while playing a D-Log + Creative Look clip, sample `#preview-canvas` at two different times
   (e.g. t≈1.0 s and t≈3.0 s) via CDP `Runtime.evaluate` `canvas.toDataURL()` (or `Page.captureScreenshot` of the
   canvas region). Assert the two hashes **differ** → frames are advancing.
2. **Frame cadence:** hook rAF via `Runtime.evaluate` and record `canvas.toDataURL()` each tick for ~2 s; count
   **distinct frame hashes** ≥ ~2×target_fps (e.g. ≥50 frames in 2 s at 30 fps) → proves streaming, not a still.
   Also assert the inter-frame interval distribution is smooth (median ≤ ~40 ms, no stall >150 ms) → smooth playback.
3. **Effect actually applied:** with D-Log M + Rec.709, compare a known region (e.g. a highlight) between
   `#preview-video` (browse mode, raw) and `#preview-canvas` (edit mode, LUT) — they must **differ** consistently
   with the LUT tone mapping.
4. **Frame-aligned with the clock:** poll `video.currentTime` and the canvas frame hash together; assert the canvas
   changes whenever `currentTime` advances by ≈one frame and does not change while paused.
5. **Watermark overlay:** toggling `#watermark-enable` must change the canvas in the watermark region (bottom-right
   by default) but not elsewhere; assert that region's pixels differ with the overlay on/off.
6. **Preview == Export consistency (strongest):** seek to an exact timestamp, capture the live `#preview-canvas` frame
   at that position, and render the same editor state through the export/frame pipeline (`editor:preview-frame`,
   `ffmpeg-frame-renderer.js`). Assert per-pixel/ΔE difference below a small tolerance → the live pipe matches the
   verified export chain (guaranteed by construction since both use `buildFilterGraph`).
7. **Mode-play regression:** click Play while in edit mode; assert the app **stays in edit mode** (canvas visible,
   effects remain) and does not flip to browse/raw video — locking in the §6 fix.

---

## 8. Risks & mitigations (Option B)

| Risk | Mitigation |
|---|---|
| **Frame-delivery bandwidth** (720p RGB24 ≈79 MB/s at 30 fps) | Render the preview canvas at the LRF size but gate delivery by the video clock; drop frames that lag. Optionally downscale the canvas to 640×360 (≈21 MB/s) or transfer buffers over a `MessagePortMain` (zero-copy) instead of copying on `webContents.send`. |
| **Process spawn/seek latency** (each restart ≈ the frame renderer's `elapsedMs`) | Keep the pipe alive during continuous play (no restarts). Restart only on explicit seek / trim / speed / control change / asset switch; pre-seek with `-ss` in the same spawn. |
| **Pipe overrun / memory** | Dead-letter when behind; pace with `-re` and/or consumer backpressure; bound the reassembly buffer. |
| **Preview vs export drift** | Prevented by construction — both use `buildFilterGraph`; still assert with §7 check 6. |
| **Surface selection conflicts** | `#preview-canvas` covers `#preview-video`; the `<video>` is the clock, never displayed over the canvas in edit mode. |
| **Trim clamp vs pipe range** | Restart the pipe with the clip's `sourceInUs`/`sourceOutUs` when trim changes (as export does at `ffmpeg-export-renderer.js:11-12`). |

---

## 9. STOP — explicitly out of scope

- Do not implement anything from this doc in this phase; deliver it and stop.
- No new color/effect features, no DUML/SWUDP/FPV, no complex editors, no broad UI redesign.
- Keep `browse()` (raw) and export behavior unchanged; only add the continuous edit preview stream.

---

### Appendix A — file:line index (quick reference)
- `renderer/renderer-phase3.js:25` debounce · :146 setMode · :217 browse · :248 edit · :252 still render · :284 play
  button · :142 editorFromControls · :256 applySeek · :336 timeline seek · :281 timeupdate clamp
- `preload/preload.js:11` renderEditPreview · :6 getPreviewUrl
- `main/main.js:72` colorPresets · :73 graphForEditor · :79 service init · :88 preview-url · :93 preview-frame
  · :94/95 export
- `renderers/color-render-service.js:7` renderPreviewFrame
- `renderers/ffmpeg-frame-renderer.js:6-14` render · :10 scale trick · :16 run
- `renderers/filter-graph-builder.js:1-42` buildFilterGraph (geometry :8-15 · technical LUT :19-26 · creative :28-32
  · eq :33-34 · watermark :36)
- `color/pipeline.js:14-15` dlogMGraph/action4DlogGraph · `color/effect-graph.js:6-17` createEffectGraph
- `color/lut-registry.js:14-24` createOfficialLutRegistry · `color/cube-lut.js:24-30` sampleCube ·
  `color/lut-engine.js:1-2` applyLutToRgbFrame (Option-A reference)
- `preview/lrf-preview-source-resolver.js:1-4` · `preview/preview-mode.js` · `watermark/watermark-registry.js:3` ·
  `watermark/watermark-position.js:3-5` overlayExpressions
- `renderer/index.html:28` .shell-content video/img surfaces

### Appendix B — measured benchmark (repro)
`ffmpeg -v info -hwaccel auto -loop 1 -i wm.png -i "d log 10bit.LRF" -filter_complex "<graph with dlog.cube +
forest.cube + eq + watermark overlay>" -map [outv] -frames:v 240 -f null - -benchmark` →
`frame= 240 ... speed=23.5x elapsed=0:00:00.40` ⇒ ≈600 frames/s ≈23.5× realtime at 1280×720.

---

## 10. Implementation status (engineer t4)

> **Status:** Option B **implemented** (task t4). This section records what was built
> and the explicit deviations from the plan above; the plan in §1–§9 remains the design
> reference. See `IMPLEMENTATION_NOTES.md` for the full change log.

Implemented exactly as recommended (Option B — long-lived ffmpeg live filter pipe →
`<canvas>`), reusing `buildFilterGraph` verbatim so Preview == Export by construction.

The single integration point the plan got right (and which had to be fixed): the play
button in edit mode now continues playback **with** the live effect stream instead of
reverting to raw browse (§6). The renderer keeps the hidden `<video>` as the master clock
and the opaque `#preview-canvas` as the edit-mode effect surface.

### 10.1 Explicit divergences

1. **Live canvas is 640×360** (plan: 1280×720, or optional 640×360). Chosen to keep IPC
   bandwidth/memory bounded; the colour/geometry math is still applied at full source
   resolution before the final downscale (scale is the last graph filter), so Preview ==
   Export colour is preserved; the single-frame still remains 1280×720. Use a downscaled
   still for §7 check 6.
2. **`resume` / `update` / `pause` carry the clock position** (`timelineSeconds`). The
   renderer owns the `<video>` clock and must tell the pipe where to re-seek so the
   effect stays aligned. Consistent with §5.6 (position only selects the read cursor).
3. **Added `-t`** to the pipe so a trimmed clip does not play past `sourceOut` (mirrors
   export's `-t`). Not specified in the plan.
4. **Pacing** uses a lightweight pace timer + coarse backpressure instead of `-re` alone
   (`-re` measured ~4× real-time on this Windows box, so it cannot keep the pipe at 1×;
   `setTimeout` quantizes to ~15.6 ms). The pace timer is clamped into the ~31 ms bucket
   (~32 fps) and backpressure pauses ffmpeg at a bounded buffer, keeping it real-time.

### 10.2 Notes for the tester (t3)

- Live effect surface = `#preview-canvas` (640×360); single-frame still is 1280×720.
- The pipe delivers ~32 fps steady with the real bundled clips; the canvas must advance
  (not freeze) during edit-mode playback and hold still when paused.
- `editor:preview-frame` still works for the single-frame / fallback path (unchanged).
- Verify §7 checks against the canvas (not the `<img id="color-preview">`, which is no
  longer the live surface in edit mode).