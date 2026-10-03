# DJI Osmo Desktop

A Windows desktop application for offloading, restoring and exporting footage
from DJI Osmo cameras. It reads the camera card directly, works out what each
clip actually is, restores D-Log / D-Log M to Rec.709 with DJI's own transform,
optionally burns in the official camera watermark, and exports H.264 MP4 —
one clip at a time or a whole card in one go.

Current release: **v2.5.0** — the portable build is attached to
[Releases](https://github.com/nglah185-gif/DJI-Osmo-Desktop/releases).

## What it does

| | |
|---|---|
| **Camera library** | Detects a connected DJI camera, scans `DCIM`, and lists video, photos and LRF proxies without copying anything first. |
| **Local library** | Add folders or import individual files; camera and local media share one grid. |
| **D-Log restoration** | The colour mode is read from the clip's own DJI metadata rather than guessed from the filename, and the matching first-party Rec.709 transform is applied. The chain keeps 10-bit precision end to end. Batch export can also be told the model by hand for footage whose metadata no longer names the camera. |
| **Watermarks** | All 192 official badges DJI ships, mapped to the 19 device tokens behind their file names and offered through a picker that draws each badge instead of naming it. The list is grouped by device with the clip's own model first and the plain styles leading each group; footage whose model cannot be identified still gets the default device's whole set. Size and placement come from an ink box measured off each asset, so the mark lands on the same visual line on landscape video, portrait video and stills alike. |
| **File naming** | Exports and backups can be named from a template: prefix, metadata pieces, suffix, separator and an optional running number, with a live example built from the clip that is open. The pieces are the ones DJI footage makes useful — capture date, model, log profile, bit depth, resolution, frame rate — and an empty piece is dropped rather than leaving a doubled separator. |
| **Backup** | The camera's own file can be copied to a second folder as part of the same transfer, under the same naming rules. A file that is already there with the same size and time is skipped; a different file with that name is kept alongside it, never overwritten. |
| **Copyright** | Creator, copyright and a note are written into every export: container metadata for video, and an XMP packet for stills with the camera's EXIF left intact — the field DJI itself does not offer. |
| **Editing** | Non-destructive trim, speed, rotate, crop and flip, plus the creative LUTs that ship for some models. The trim is a bracketed range — `[=====]` — whose cut ends are hatched and whose brackets follow the drag. Source files are never modified. |
| **Interface** | A darkroom: the picture sits on the darkest surface, the two side rails a step above it, and glass is spent only on content. Both rails are resizable by dragging the seam (double-click resets, arrows nudge), and the media grid re-lays itself out to fill the rail. |
| **Live preview** | A frame streamer driven by the *same* effect graph the export uses, so the preview cannot disagree with the file. |
| **Export** | Single clip or a batch, video and stills together. A clip with no changes is stream-copied at the speed of the card; anything with an effect is re-encoded. Photos keep their EXIF and are stamped with their capture time. Batch exports are resumable and cancellable per item. |
| **GPU acceleration** | The 3D LUT runs on the GPU through ffmpeg's `libplacebo` (Vulkan) where available — measured 1.73x on a 4K D-Log export — with an automatic fallback to the CPU path when the build, the driver or the GPU cannot provide it. |
| **Bilingual UI** | English and 简体中文. |

## Requirements

- Windows 10 or later
- Node.js 20+ for development (the portable build bundles its own runtime)
- FFmpeg and FFprobe — see below

### FFmpeg

The application spawns FFmpeg as a child process; it does not link against it.

Place a **full** FFmpeg build at `bin/ffmpeg.exe` and any `ffprobe.exe` at
`bin/ffprobe.exe`:

```powershell
bin/
  ffmpeg.exe     # "full" build — required for the GPU LUT
  ffprobe.exe    # any build; only metadata is read
```

Why the full build: GPU colour restoration needs the `libplacebo` filter, which
Gyan's *essentials* variant does not ship. This is a capability, not a hard
requirement — with an essentials build the application detects the missing
filter and exports through the CPU LUT instead, about 1.7x slower on 4K D-Log.

Download: <https://www.gyan.dev/ffmpeg/builds/> → `ffmpeg-release-full.7z`

FFmpeg is GPLv3. Bundling it inside a distributed package means the package has
to honour those terms.

### Colour assets

The official LUTs and watermark images are DJI assets and are **not** part of
this repository. The application resolves them from folders beside the project:

```
<workspace>/
  dji-osmo-desktop-v2/    <- this repository
  cube&luts/              <- official Rec.709 transforms
  watermark/              <- official badge PNGs
  lut&log/                <- optional additional LUTs
```

`npm run package:portable` copies them into the package. Without them the
application still starts, but colour restoration and watermarking are
unavailable and the UI says so. Use and redistribute those assets under their
own licences.

### Supported cameras

Watermark badges exist for every device DJI ships artwork for: Action 3, Action
4, Action 5, Action 5 Pro, Action 6, Pocket 3, Pocket 4, Pocket 4 Pro, Osmo Nano,
Osmo 360, Osmo Mobile 6/7/7 Pro/8/8 Pro, plus the partner marks (COROS, HUAWEI,
iGPSPORT, Magene, SUUNTO, EB100 and the Huawei watch co-brands) and the seasonal
one. Colour restoration covers the seven bodies the application holds a DJI
transform for — Action 4, Action 5 Pro, Action 6, Pocket 3, Pocket 4, Pocket 4
Pro and Osmo Nano — and the batch dialog can be pointed at any of them by hand
when a file's metadata no longer names its camera. The three Action transforms
ship inside the official DJI downloads in `cube&luts`; the Pocket and Nano ones
came out of the DJI Mimo asset set and live in `lut&log`, which is optional —
without that folder the application simply offers fewer models.

Two cases are deliberately left alone. Bodies that record plain Rec.709 (Action
3, Action 5, the gimbals) have nothing to restore. A log flavour DJI has not
published a transform for — Osmo 360, the newer D-Log 2 profiles — is not pushed
through a neighbouring model's LUT, because a wrong transform is much harder to
notice than a missing one. A camera the application does not recognise is treated
as a plain H.264/HEVC source, but always keeps the full set of badges.

## Development

```powershell
npm install
npm start                  # run the app
npm test                   # unit suite; needs no camera and no network
npm run package:portable   # build the portable ZIP into release/
```

Other scripts:

```powershell
npm run test:pipeline      # media pipeline only
npm run test:color         # colour pipeline only
npm run test:hotplug       # device hotplug regression
npm run validate:phase2    # LUT equivalence + golden frame validation
```

The application icon is generated rather than drawn by hand — the mark is one
SVG in `scripts/make-app-icon.js`, rasterised through Electron's canvas into
`assets/app-icon.png` and a multi-size `assets/app-icon.ico`, which the window
and the packaged executable both use:

```powershell
node_modules\electron\dist\electron.exe scripts\make-app-icon.js
npm run package:portable   # also stamps the icon onto the executable
```

UI probes run against a *running* app over the DevTools protocol, so start the
app with `--remote-debugging-port=9222` first:

```powershell
node scripts/batch-export-probe.js   # batch export and selection UI
node scripts/ui-capture.js <label>   # screenshot into artifacts/ui/
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the system is put together today.
- [`docs/README.md`](docs/README.md) — index of the historical per-phase notes in `docs/notes/`.
- [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md) — the original brief and design principles.

## Known limitations

- **Photos take a separate path.** A clip goes through the colour pipeline and the
  encoder; a still gets one watermark overlay and a single JPEG encode (or a plain
  copy when no watermark is chosen), carrying its EXIF and capture time across.
  Both are exportable from the same batch dialog and from
  `scripts/export-camera-batch.js`.
- **Parallelism does not scale throughput.** A single 4K D-Log export uses about
  60% of a 12-thread CPU, but two at once only gain around 10%: the hardware
  encoder is a single shared engine, and the Rec.709 LUT is CPU-bound when the
  GPU path is unavailable. Batch export is a convenience, not a throughput
  feature.
- **Output is H.264 8-bit** even for 10-bit sources. Precision is kept through
  the colour chain and dropped once at the encoder, for player compatibility.
- **Single video track.** No multi-track editing, keyframes, transitions or
  audio tools.
- The repository is a preview build, not a finished product.

## Third-party components

| Component | Role | Licence |
|---|---|---|
| [Electron](https://www.electronjs.org/) | application runtime | MIT |
| [FFmpeg](https://ffmpeg.org/) | decode, filter, encode, probe | GPLv3 (bundled build) |
| [libplacebo](https://code.videolan.org/videolan/libplacebo) | GPU 3D LUT via Vulkan | LGPL-2.1+ |

Official DJI LUTs, colour profiles and watermark images remain DJI's property
and are not covered by any licence granted here.
