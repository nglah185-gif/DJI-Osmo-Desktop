# Phase 4 Product Workflow V2

## Status

COMPLETE (software). All eight Phase 4 workstreams implemented without touching Device Adapter, MediaProbe, PairingEngine, MediaAsset, EffectGraph, Export Pipeline, or Color Resource Registry internals.

- Sorting and filtering with real metadata.
- Preview fallback (ORIGINAL_FALLBACK) for no-LRF clips.
- Live D-Log M / Creative Look / Watermark preview through the shared EffectGraph.
- Settings page (Language + Export Location) with persistence.
- Color UI redesigned: Source Color (Auto unknown / Normal / D-Log M), Color Restoration (Action 4 D-Log M to Rec.709), Creative Look.
- Timeline interaction: real playhead seek, Trim Start / Trim End handles, speed, range clamping.
- Local Library as a separate source with unified MediaAsset/editor/export.
- Watermark five-position presets with normalized coordinates and live preview.

## Verification

- npm test: 85 pass, 0 fail.
- CDP smoke on real Action 4: sorting changes order; settings opens with default export location = Videos; local source shows empty state with Add Folder; watermark enable and position changes alter the rendered edit frame immediately; no renderer errors.

## Remaining for human acceptance

Physical GUI pass (camera insert cycle, Add Folder / Import Files dialogs, Export to chosen location, English/Simplified Chinese switch persistence after restart).
