# DJI Color Mode Auto-Detection (V2)

**Status: verified on the real card. 87/87 clips classified correctly.**

## What the camera really stores

D-Log M vs Normal is **not** stored in any standard color metadata. Both modes are
encoded identically at the bitstream level — HEVC Main 10 / 10-bit / yuv420p10le /
BT.709 / tv range, no HDR boxes. The mode lives in three DJI-private places:

| Signal | Where | D-Log M | Standard |
|---|---|---|---|
| djmd protobuf field 2.3.5 | in-file `djmd` track (mdat head) | 10 | 8 |
| djmd protobuf field 2.4 | in-file `djmd` track (mdat head) | {1:1} (22 02 08 01) | empty (22 00) |
| udta `dbcm` atom | moov/udta | present, payload 4 | absent |
| AC002.db video_info.digital_effect | camera DB (not in-file) | 1 | 0 |

Two independent same-scene pairs (0371/0372 and 0367/0368) plus the whole 87-clip
card cross-check with AC002.db confirm **digital_effect and the djmd fields agree
for every clip** → the djmd marker is a per-clip recording-setting flag, not a
coincidence. Mimo and DJI's own tools read these private fields; no visible
"color mode" file exists on the card.

## Detector

`src/color/dji-color-mode.js` reads only the file head (256 KiB default; the djmd
track is written at the start of the mdat payload):

- finds the top-level `mdat` box (handles 32-bit and 64-bit sizes),
- parses the djmd protobuf stream with a minimal wire-format decoder
  (varint + length-delimited fields only),
- classifies from `[2.3.5]` and/or `[2.4]`:
  - `2.3.5 = 10` or `2.4 = {1:1}` → **D-Log M**
  - `2.3.5 = 8` or `2.4 = empty` → **Standard**
  - neither → **UNKNOWN** (non-DJI files, foreign cameras),
- keeps the exact 10-byte header windows as a secondary (fallback) signal.

No AC002.db needed → detection also works for Local Library imports and for
file copies that keep the djmd track. Cost is a few KiB of I/O per clip.

## Wired into the product

- `media-pipeline.js` attaches `djiColorMode` + `djiColorModeEvidence` to every
  camera asset (injectable `colorModeDetector` for tests).
- `local-scanner.js` does the same for Local Library entries.
- Renderer:
  - card badge **"D-Log M"** (purple) or **"Normal"** (muted) on every clip,
  - opening a clip auto-sets Source Color + Color Restoration to the detected
    mode (`action4-dlogm` / `action4` for D-Log M), still user-overridable,
  - an inspector hint reads "Auto-detected from camera metadata: D-Log M (detected)".
- i18n: new keys `color.detectedDlog`, `color.detectedNormal`, `color.detectedUnknown`,
  `color.detectHint` in en + zh-CN.

## Tests (7 new, 92 total, all green)

`test/dji-color-mode.test.js`:

- synthetic protobuf samples (D-Log M / Standard / field-2.4-only / junk),
- window constants pinned to the verified real-file byte sequences,
- real offline fixtures: `d log 10bit.MP4` → D-Log M, `普通色彩.MP4` → Standard,
  `高帧率.MP4` / `竖屏高帧率视频.MP4` → Standard (both are slow-mo Standard clips),
- real LRF fixtures carry the same marker.

## Live verification

- Node run over all 87 card MP4s: **78 D-Log M / 9 Standard / 0 UNKNOWN** —
  identical to AC002.db digital_effect counts (78/9).
- Electron CDP smoke on the real device:
  - 0371 card shows `D-Log M`, 0372 shows `普通` (the two clips the user
    recorded for this comparison),
  - clicking 0371 auto-selects Source Color = D-Log M and Restoration =
    Action 4, with the detect hint shown.

## Files changed

- `src/color/dji-color-mode.js` (new detector)
- `src/media-pipeline.js` (asset fields + injectable detector)
- `src/local-library/local-scanner.js` (local detection)
- `src/renderer/renderer-phase3.js` (badge, auto-preset, hint)
- `src/renderer/index.html` (hint element)
- `src/renderer/styles.css` (`.badge.dlog`, hint style)
- `src/i18n/en.js`, `src/i18n/zh-CN.js` (4 keys)
- `test/dji-color-mode.test.js` (new)
