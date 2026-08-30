# GOLDEN_FRAME_VALIDATION_V2.md

## Scope

Golden frame timestamp: 00:00.500. The only current V2 technical transform is the official Action 4 D-Log M to Rec.709 CUBE. The LRF is the preview source; the Original MP4 is the export source. Color mode is explicitly selected, never inferred from codec metadata. The fixture name does not certify D-Log M; these metrics are pipeline evidence, not Mimo-reference accuracy.

## Results

| Mode | Shared graph | Preview ms | Preview FPS | Renderer CPU ms | Renderer RSS MB | Export ms | Same-source preview/export MAE | Same-source RMSE | LRF preview/export MAE |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| action4-dlogm-official-cube | false | 366 | 2.7322 | 16.0000 | 46.9023 | 3078 | 1.9350 | 2.3477 | 2.5953 |

## Acceptance

- PASS: preview and export compile the exact same official-CUBE EffectGraph.
- PASS: same-source preview and export RGB metrics are recorded; small differences are expected from PNG/MP4 encode and decode.
- INFORMATIVE: LRF versus Original is not an accuracy pass/fail because LRF is an 8-bit BT.709 proxy. Run scripts/original-lrf-lut-experiment.js against explicitly confirmed D-Log M media before choosing an Original-decode preview policy.
- NOT YET AVAILABLE: a Mimo reference export for a confirmed matching D-Log M source. No SSIM, Delta E, or Mimo-accuracy claim is made without it.

Artifacts are under artifacts/golden-frames/.
