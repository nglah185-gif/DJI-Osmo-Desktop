# RUST_MIGRATION_ASSESSMENT_V2

## Ports with little conceptual change

- MediaAsset and pairing/domain schemas
- Timeline arithmetic and clip invariants
- EffectGraph and ColorProfile schemas
- LUT/style/watermark registry metadata
- Sorting, validation fixtures, golden-frame expectations, and asset hashes
- FFmpeg filter-graph semantics, export contracts, and official DJI assets

These designs port, but JavaScript implementations and tests still require translation or a language boundary.

## Must be rewritten or replaced

- Electron main-process lifecycle and BrowserWindow setup
- preload/contextBridge API and every IPC handler
- custom `dji-media` protocol and authorization maps
- preview-frame transport, buffering, backpressure, and restart state machine
- renderer integration, session event wiring, filesystem dialogs, and settings bridge
- packaging, updater, crash reporting, signing, and Windows installer workflow
- any attempt at native GPU preview: decoder surfaces, color conversion, LUT shader, overlay composition, synchronization, and device-loss recovery

## Assets and backends that remain unchanged

- DJI CUBE files, THM/SCR/LRF/MP4 media, watermark PNGs, and test media
- FFmpeg/ffprobe as the export and validation backend
- Golden frames and numeric tolerances
- Product UI requirements and media workflow

Rust does not imply replacing FFmpeg. Rust -> FFmpeg remains a reasonable export and initial preview orchestration design. Replacing FFmpeg only makes sense for a measured native GPU interop requirement.

## Cost and risk

| Option | Cost | Expected performance value | Main risk |
|---|---|---|---|
| Fix Electron preview | Low | High for current defects | Raw IPC remains a future resolution ceiling |
| Tauri + same WebView/raw frames | High | Unproven | Recreates the same copies and canvas upload |
| Rust core behind Electron | Medium | Useful for state isolation/telemetry, not automatically faster | Boundary design can retain all current costs |
| Native Rust GPU renderer | Very high | Highest ceiling | Codec/GPU/UI integration and maintenance burden |

## Recommendation

Do not perform a wholesale migration. First fix and benchmark the existing Electron restart state machine. If 720p/4K preview later requires more headroom, prototype a narrow native/Rust GPU preview core behind the existing UI with a zero-copy or shared-surface contract. Preserve FFmpeg export.

