# LRF_ORIGINAL_LUT_INPUT_ANALYSIS_V2.md

## Scope

This experiment studies how the same official Action 4 D-Log M to Rec.709 CUBE behaves on an Original MP4 and its LRF proxy. It does not assert that either named sample was recorded in D-Log M. The normal-color pair is a control for proxy/source behavior, not a correctness test for a D-Log M transform.

## Method

- Timestamps: 00:00.500, 00:01.000, 00:01.500.
- A: Original MP4, no LUT; B: LRF, no LUT; C: Original MP4 plus official Action 4 CUBE; D: LRF plus the same official CUBE.
- Every output is 1280x720 RGB24 PNG. Original is downscaled with FFmpeg after decode; LRF remains decoded at its native 1280x720. No range, gamma, or chroma compensation was added.
- Difference images use absolute RGB difference: A_vs_B.png and C_vs_D.png.
- FFmpeg decoder metadata on both sources is limited-range BT.709 matrix, primaries, and transfer. Original is yuv420p10le HEVC at 59.94 fps; LRF is yuv420p H.264 at 29.97 fps; both signal left chroma siting. The shared metadata does not prove identical decoded RGB or prove D-Log M.

## Results

| Pair / timestamp | A/B MAE | A/B RMSE | A/B PSNR | A/B SSIM | A/B hist L1 | C/D MAE | C/D RMSE | C/D PSNR | C/D SSIM | C/D hist L1 | Max C/D | RMSE multiplier |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dlog-named / 0.500 | 1.3939 | 3.0345 | 38.4892 | 0.9748 | 0.201937 | 1.7082 | 3.7348 | 36.6854 | 0.9591 | 0.191437 | 96 | 1.231 |
| dlog-named / 1.000 | 1.4063 | 2.8626 | 38.9955 | 0.9767 | 0.218795 | 1.8070 | 3.6379 | 36.9138 | 0.9619 | 0.234460 | 88 | 1.271 |
| dlog-named / 1.500 | 1.4150 | 2.9135 | 38.8426 | 0.9747 | 0.212684 | 1.7343 | 3.6463 | 36.8938 | 0.9598 | 0.199517 | 89 | 1.252 |
| normal-named / 0.500 | 2.0583 | 4.4294 | 35.2038 | 0.9533 | 0.287632 | 2.2414 | 5.1851 | 33.8356 | 0.9344 | 0.234039 | 136 | 1.171 |
| normal-named / 1.000 | 1.9968 | 4.3842 | 35.2931 | 0.9547 | 0.271598 | 2.1473 | 5.1310 | 33.9268 | 0.9385 | 0.194443 | 136 | 1.170 |
| normal-named / 1.500 | 2.0084 | 4.3913 | 35.2790 | 0.9518 | 0.296156 | 2.1421 | 5.1322 | 33.9247 | 0.9369 | 0.206205 | 132 | 1.169 |

## Difference amplification

For the unconfirmed D-Log-named pair, mean C/D-to-A/B RMSE multiplier is 1.251 and mean SSIM change is -0.01509. A multiplier above 1 means the CUBE increases the proxy/original difference; it does not establish a color-management bug by itself.

## Input-domain interpretation

- No obvious metadata-level range or matrix mismatch exists: all four sources signal MPEG/TV range with BT.709 matrix, primaries, and transfer; both LRF files retain left chroma siting.
- There is nevertheless an unavoidable representation mismatch: Original is decoded from 10-bit 4:2:0 HEVC at 59.94 fps, while LRF is decoded from 8-bit 4:2:0 H.264 at 29.97 fps. Scale, temporal sampling, quantization, and codec decisions therefore remain sources of pre-LUT pixel difference.
- No ungrounded range or gamma adjustment was attempted. Such compensation would change the stated input semantics and could hide, rather than explain, the proxy divergence.

## Decision

**NOT RECOMMENDED**: LRF -> official CUBE -> Preview for color-critical editing.

The decision follows the measured C/D versus A/B behavior above. For ordinary browsing, LRF remains appropriate. If the decision is not RECOMMENDED, choose **Option B**: ordinary browsing uses LRF; color adjustment and LUT preview uses Original decode -> downscale -> official CUBE. Option C is reserved for a future decision when the measured need outweighs its performance cost.

## Artifacts

All four baseline PNGs and A/B and C/D difference PNGs are in `artifacts/lrf-original-lut-input-analysis/`.
