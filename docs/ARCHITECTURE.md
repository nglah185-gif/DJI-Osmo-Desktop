# Architecture

How the application is put together, as of v2.5.0. The per-phase notes in
[`notes/`](notes/) record how each piece got here; this file describes the state
that resulted.

## Processes

Two processes, one narrow bridge.

```
┌─ main process (Node, sandbox off) ──────────────────────────────┐
│  device scan · catalog · ffmpeg · file serving · export queue    │
│  src/main/main.js                                                │
└───────────────┬─────────────────────────────────────────────────┘
                │  preload: contextBridge → window.djiMedia
                │  src/preload/preload.js  (invoke + event listeners)
┌───────────────┴─────────────────────────────────────────────────┐
│  renderer (sandboxed, contextIsolation, no nodeIntegration)      │
│  browser UI · virtual grid · timeline · state machines           │
│  src/renderer/index.html → renderer-phase3.js                    │
└──────────────────────────────────────────────────────────────────┘
```

The renderer never learns a filesystem path it did not already own. Media is
served back over a custom protocol (`dji-media://`) and every path the protocol
may return has to be registered first by the main process, in a map keyed by
asset id (`authorizedPreviewPaths`, `authorizedThumbnailPaths`, …). Thumbnails
add a size tier to that key (`assetId@116`) because Chromium caches by URL and
the same clip legitimately resolves to a different file for a list tile than for
a poster tile.

## Media acquisition

```
USB device ──► device-adapter/          detect DJI mass storage (hotplug watched)
           ──► media-access/            read-only file access
           ──► media-pipeline.js        scan DCIM, pair related files
           ──► media-probe/             ffprobe each file
           ──► catalog/                 in-memory catalog, queried by id
```

- `src/device-adapter/windows-mass-storage-device-provider.js` — finds DJI cards.
- `src/media-pipeline.js` — orchestrates a scan; emits progress.
- `src/pairing/scored-pairing-engine.js` — matches a clip's companions
  (LRF proxy, sidecar, thumbnail) to the clip itself.
- `src/preview/lrf-preview-source-resolver.js` — decides whether a clip can be
  previewed from its LRF proxy, the original, or a generated fallback proxy.
- `src/local-library/` — the same model for ordinary folders and files.

## Colour

Two stages, kept deliberately separate: **which transform** a clip needs, and
**how that transform is executed**.

```
clip metadata ──► color/dji-color-mode.js    D-Log M / D-Log / Standard, from the
                                             clip's own DJI protobuf, not the name
              ──► color/auto-restore.js      camera family → transform key
              ──► color/pipeline.js          profile + Rec.709 transform
              ──► color/effect-graph.js      the render description
```

- `src/color/lut-registry.js` registers the official LUTs, each with a SHA-256,
  and the filter graph verifies the hash before using one.
- `src/color/cube-lut.js`, `hald-lut.js`, `mika-lut.js` parse the asset formats.
- `src/renderers/filter-graph-builder.js` turns an effect graph into one ffmpeg
  `-filter_complex` string: source interpretation → crop/rotate/flip → technical
  transform → creative looks → adjustments → overlay → output format.
- `src/color/metrics.js` (PSNR/MAE) is what the validation scripts compare with.

The chain works in `yuv420p10le` throughout and converts once at the encoder.

## Preview

`src/renderers/preview-frame-streamer.js` renders frames from the same effect
graph the export uses, and `preview-canvas-surface.js` paints them. That
identity is the point: the preview cannot drift from the exported file, because
there is only one description of the picture.

When a clip has no LRF companion and its codec is not editable directly,
`src/thumbnail/fallback-proxy.js` builds a proxy first and reports progress.

## Export

`src/renderers/ffmpeg-export-renderer.js` is the whole pipeline. In order:

1. **Plan** (`export-plan.js`) — does anything change the picture? Trimming and
   muting do not; crop, rotation, colour, a style or an overlay do. An export
   that changes nothing is a stream copy and runs at the speed of the card
   (measured 16s against 296s on the same 4K clip).
2. **Probe** (`source-probe.js`) — one ffprobe with a 10s deadline for codecs and
   duration. The duration also bounds the output, which matters because a
   watermark is a looped image input and would otherwise never end.
3. **Capabilities** — `encoder-selection.js` probes a real one-frame encode
   rather than trusting `-encoders`, and `gpu-lut.js` checks whether this ffmpeg
   carries `libplacebo`. Both cache their answer and both can be disabled at
   runtime by the first genuine failure.
4. **Build** — `filter-graph-builder.js`, ending in the format the encoder wants.
5. **Run** — with progress parsed from `-progress`, and the whole thing bounded
   by the probed duration.
6. **Validate and rename** — ffprobe the finished file, then rename it into place,
   so a failed export cannot leave a readable-looking half file.

Anything that can fail has a fallback path: hardware encoder → software, GPU LUT
→ CPU LUT, stream copy → re-encode.

## Watermark catalogue

`src/watermark/watermark-registry.js` is the single authority on which badge is
which. DJI's artwork names itself in its own file names — `pic_watermark_oa4_1.png`
is token `oa4`, variant 1 — so the registry parses the file name into a device
family, a variant kind (`standard`, `borderless`, `frame`, `partner`, `seasonal`)
and a brand where one applies, then derives a stable id
(`action4.official.oa4.coros`). All 192 badges across 19 tokens resolve this way,
with no two files claiming the same id (a test enforces both).

`forCameraModel()` maps a camera model from the media pipeline to one device
token set; an unrecognised model is not a dead end — the UI offers the whole
default device set instead of a single badge. `catalog()` groups every badge by
device in a fixed reading order: cameras first, the novelty badge last.

The renderer never names a badge file. `main.js` serves them over
`dji-media://asset/watermark/<id>` from an allow-list built by the registry, and
`src/renderer/badge-picker.js` — pure, unit-tested label and grouping logic —
decides what each row is called. Rows carry their own preview for a reason: two
badges of the same device differ only in the artwork, so a list of names could
not tell them apart.

## Transfer naming, backup and copyright

`src/renderer/rename-rules.js` is the naming authority, shared by the dialog and
the main process the same way the badge catalogue is. It turns a template — a
prefix mode, an ordered list of metadata pieces, a suffix mode, one separator and
an optional running number — into a file name, using `sanitize()` to keep Windows
out of trouble and dropping empty pieces so `Action4` and a non-log clip do not
produce a doubled separator. `buildName()` is the single implementation: the
example in the dialog is the name that lands on disk.

The settings (`renameRules`, `backup`, `copyright`, `exportPrefs`) travel as one
object through `settings:get` / `settings:set`. Every transfer reads them once, at
the start: a long export must finish under the naming decision it began with, so
the rules are passed into the backup step rather than re-read when it runs.

Copyright is written where each container expects it. Video goes through
ffmpeg's container metadata (`-metadata artist/copyright/comment`, added after
`-map_metadata 0` so the user's values win over the camera's blanks). A still
cannot use that path — the camera's EXIF is copied back over the encode to
preserve the capture data — so `writeJpegXmp()` appends an XMP packet instead:
an APP1 segment carrying `dc:creator`, `dc:rights` and `dc:description`, which is
also the only metadata block that can be inserted without rewriting offsets.

## Batch export

`src/tasks/export-queue.js` is a serial-by-default queue: per-item state,
per-item cancel, error isolation, monotonic progress. `main.js` builds one effect
graph per clip — restoration is per camera — and adds the work.

Concurrency is 2. It is not a throughput feature and the code says so: measured,
a second concurrent export buys about 10%, because the hardware encoder is a
single shared engine. What it does buy is overlap of the card read, the encoder
hand-off and the validation pass.

The setup sheet (`src/renderer/batch-export-options.js` for state,
`renderer-phase3.js` for wiring) is where restoration and the watermark are
chosen. Detection happens in the main process and is passed in, so the clips the
sheet calls D-Log are exactly the clips the export restores.

## Renderer / UI

Vanilla DOM, no framework, one HTML file and one stylesheet.

```
index.html ──► styles.css
           ──► virtual-grid.js      windowing; renders only visible rows
           ──► renderer-phase3.js   the controller
           ──► badge-picker.js      badge labels and grouping (pure)
           ──► batch-export-state.js / batch-export-options.js  presentation state
           ──► export-modal-state.js
           ──► editor-ui-state.js   inspectors, timeline, controls
           ──► icons.js             the whole icon set
           ──► i18n/                en + zh-CN, key sets kept identical by a test
```

Two conventions hold the test suite together:

- **Pure logic lives in sibling modules**, not in the controller. Everything
  testable is exported twice — `window.__thing` for the browser and
  `module.exports` for Node — so a test can require it directly.
- **The controller only wires.** DOM event handlers translate to state
  transitions; the interesting decisions are in the modules above.

Layout is driven by state, not by mode: `body.has-clip` shows the editor and
hides the library panel, the absence of it does the reverse. `state.mode`, by
contrast, is only the *preview* mode (original vs effect).

## Testing

- `npm test` — 41 files, the whole suite, no camera and no network.
- Modules that spawn processes take an injected `spawnProcess`, so tests drive
  ffmpeg behaviour without running it.
- `scripts/*-probe.js` drive a **running** app over the DevTools protocol and
  assert on the real DOM (`batch-export-probe.js`, `ui-capture.js`).
- `scripts/lut-equivalence.js` and `golden-frame-validation.js` compare renders
  against reference frames.

## Decisions that came from measurement

These are the ones a reader is most likely to want to re-litigate, so the
numbers live in the code next to them.

| Decision | Measurement |
|---|---|
| Stream copy when nothing changed | 16.2s vs 296s on the same 4K clip |
| Batch concurrency 2, not more | 2 concurrent: ~1.10x. Single export already uses ~60% of 12 threads |
| GPU LUT (libplacebo) | 1.73x on a 4K D-Log export; LUT is 59% of the work |
| `lut_type=2` for GPU LUT | default `auto` mismatches the CPU result by MAE 14; `normalized` matches to MAE 0.49 |
| `h264_mf` at quality 100 | 45.4 dB → 52.0 dB against a 100-quality render, same encode time |
| 10-bit working format | rgb24 at three points cost bandwidth and precision |
| Thumbnail size tiers | THM is 160×90, SCR is 1280×720; the poster grid needs the SCR |
| Hardware encoder probe | `-encoders` lists encoders that fail on the installed driver |
