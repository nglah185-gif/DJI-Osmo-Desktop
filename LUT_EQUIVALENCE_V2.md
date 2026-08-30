# LUT_EQUIVALENCE_V2.md

## Scope

This is a historical research comparison only. The APK Hald is RESEARCH_ONLY and is not eligible for V2 preview, export, default, or automatic technical transforms.

## Compared resources

- APK Hald: E:\dji_desktop(1)\dji.mimo\assets\DJI-Assets\lut\LOG_AC4DLogM\userlut_dlogm_rec709_action4.png
- APK SHA-256: E7933B9C1F5D0D16B290E8D27EA4209BA5B745E6C620CE175A079AE863EDEF5D
- Website CUBE: E:\dji_desktop(1)\cube&luts\DJI OSMO Action 4 D-Log M to Rec.709 V1.cube
- Website SHA-256: B18162854AB47702068410C33AFA98A8CB6EEF159FC5A04CE0E65FAD0FD8947E
- Hald: 512x512 standard Hald, decoded as 64^3
- CUBE: LUT_3D_SIZE 33
- Unified input grid: 33^3 = 35937 RGB points

## Classification

**DIFFERENT**

Classification uses numeric samples and not filenames. Both resources remain separately registered.

## Numeric comparison

| Metric | Result |
|---|---:|
| MAE, normalized RGB | 0.166028 |
| RMSE, normalized RGB | 0.293751 |
| Max channel error | 1.000000 |
| Percent within 1/255 | 17.189341% |

## Visual frame comparison

Timestamp: 00:00.500. Original was scaled to 1280x720. Both paths used the same CPU trilinear sampler.

| Comparison | MAE | RMSE | Max error | PSNR |
|---|---:|---:|---:|---:|
| LRF Hald vs LRF CUBE | 42.001630 | 73.163902 | 250.000000 | 10.844866 dB |
| Original Hald vs Original CUBE | 42.775382 | 74.254218 | 250.000000 | 10.716381 dB |
| LRF Hald vs Original Hald | 11.263432 | 26.985618 | 255.000000 | 19.508156 dB |

## Artifacts

- artifacts/lut-equivalence/action4-lrf-hald.png
- artifacts/lut-equivalence/action4-lrf-cube.png
- artifacts/lut-equivalence/action4-original-hald.png
- artifacts/lut-equivalence/action4-original-cube.png

## Interpretation

The official website CUBE is the V2 Action 4 technical transform. The APK Hald remains only for research comparison. No source substitution is performed.
