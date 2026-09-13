# LUT_REGISTRY_V2.md

## Official technical resources

| Resource ID | Source | Format | Input -> output | SHA-256 | State |
|---|---|---|---|---|---|
| action4.dlogm.rec709.apk-hald | DJI Mimo APK | 512x512 standard Hald, 64^3 | DJI D-Log M -> Rec.709 | E7933B9C1F5D0D16B290E8D27EA4209BA5B745E6C620CE175A079AE863EDEF5D | CONFIRMED |
| action4.dlogm.rec709.website-cube | DJI official website resource | CUBE, 33^3 | DJI D-Log M -> Rec.709 | B18162854AB47702068410C33AFA98A8CB6EEF159FC5A04CE0E65FAD0FD8947E | CONFIRMED |

Both resources are registered independently and SHA-256 checked at load. The website CUBE is not substituted for the APK Hald.

## Equivalence result

The deterministic 33^3 RGB comparison classified the two trusted resources as DIFFERENT: MAE 0.166028, RMSE 0.293751, maximum normalized channel error 1.000000, and 17.189341% of channels within 1/255. Full evidence and image artifacts are in LUT_EQUIVALENCE_V2.md.

The local CUBE header contains comments referring to Mavic 3 Pro and a 2023 date even though its filename is Action 4. It remains registered as the user-required official website resource, with that header discrepancy retained as a caveat.

## A06 style resource

FT_StyleA06 is not part of the official technical LUT table. Its config declares service mika.style_json, its filter declares service mika.lut, and its resource is a 2048x1024 MJPEG atlas. It is decoded as a 16x8 atlas of 128x128 tiles and converted to a standard 32^3 CUBE in the generated-luts cache. The source resource SHA-256 is D2FE740EB862ACAD8C59D1F234894C3C46187D95D486FA48765E0EE6982ADC82.
