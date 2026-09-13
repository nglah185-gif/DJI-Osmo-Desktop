# DJI Osmo Desktop

A Windows desktop application for offloading, restoring and exporting footage
from DJI Osmo cameras. It reads the camera card directly, works out what each
clip actually is, restores D-Log / D-Log M to Rec.709 with DJI's own transform,
optionally burns in the official camera watermark, and exports H.264 MP4 —
one clip at a time or a whole card in one go.

Current release: **v2.4.0** — the portable build is attached to
[Releases](https://github.com/nglah185-gif/DJI-Osmo-Desktop/releases).

## What it does

| | |
|---|---|
| **Camera library** | Detects a connected DJI camera, scans `DCIM`, and lists video, photos and LRF proxies without copying anything first. |
| **Local library** | Add folders or import individual files; camera and local media share one grid. |
| **D-Log restoration** | The colour mode is read from the clip's own DJI metadata rather than guessed from the filename, and the matching first-party Rec.709 transform is applied. The chain keeps 10-bit precision end to end. |
| **Watermarks** | Official per-camera badges. Size and placement come from an ink box measured off each asset, so the mark lands on the same visual line on landscape video, portrait video and stills alike. |
| **Editing** | Non-destructive trim, speed, rotate, crop and flip, plus the creative LUTs that ship for some models. Source files are never modified. |
| **Live preview** | A frame streamer driven by the *same* effect graph the export uses, so the preview cannot disagree with the file. |
| **Export** | Single clip or a batch. A clip with no changes is stream-copied at the speed of the card; anything with an effect is re-encoded. Batch exports are resumable and cancellable per item. |
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

Colour profiles and watermark families exist for Action 4, Action 5 Pro,
Action 6, Pocket 3, Pocket 4, Pocket 4 Pro and Osmo Nano. Anything else is
treated as a plain H.264/HEVC source with no restoration offered.

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

- **Batch export is video-only.** Photos are visible in the library but cannot be
  selected for batch export; the pipeline is a video colour pipeline. (An
  unattended export script that *does* handle photos lives in
  `scripts/export-camera-batch.js`.)
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
