# COLOR_PIPELINE_IMPLEMENTATION_V2.md

## Current Resource Policy

- V2 runtime technical transforms use only DJI official website CUBE resources.
- `action4.dlogm.rec709.apk-hald` and other APK-derived LUT research remain on disk and in audit material, but are `RESEARCH_ONLY`; they cannot be selected for default, automatic, preview, or export processing.
- The Action 4 profile is `PRIMARY_REAL_DEVICE`. Action 5 Pro and Action 6 profiles are `PROFILE_ONLY` until hardware validation exists.
- Source metadata and filenames do not certify D-Log M. The UI begins in `Unknown / no LUT`; Action 4 D-Log M must be selected explicitly before the official technical CUBE is applied.
- Official creative looks are Rec.709-to-Rec.709 and execute after the technical transform: Forest Pro, Ice Pro, and Nature Pro.

## Implemented pipeline

Source -> Input Color Interpretation -> Technical Color Transform -> Rec.709 Working Space -> Creative Style -> Adjustments -> Overlay -> Output.

- Source: production LRF preview path or production Original MP4 export path, authorized by the existing catalog and media protocol.
- Input Color Interpretation: source is decoded to RGB24. No D-Log M inference is made from filename or codec metadata.
- Technical Color Transform: an explicitly selected ColorProfile resolves to the Action 4 APK Hald or, when explicitly requested by code, the independent official CUBE.
- Rec.709 Working Space: the technical result is normalized to RGB working frames before style and adjustment nodes.
- Creative Style: only FT_StyleA06 is exposed. The MIKA atlas is converted to a standard 32^3 CUBE for FFmpeg execution.
- Adjustments: exposure, contrast, and saturation nodes are supported through FFmpeg eq when present in the graph.
- Overlay: an explicit no-op overlay boundary preserves the graph stage; no broad watermark or editing system is included in Phase 2.
- Output: preview returns a PNG frame over IPC; export encodes the transformed Original MP4 as H.264/AAC MP4.

## Preview and export

The main process owns both FfmpegFrameRenderer and FfmpegExportRenderer. The renderer exposes only safe preset names through preload IPC. The UI has Raw LRF, Action 4 D-Log M, and FT_StyleA06 modes. The export control is disabled for Raw LRF and always reads the Original MP4 asset path.

CPU preview is the correctness fallback. The latest 1280x720 measurements were 176 ms (5.68 FPS) for Action 4 D-Log M and 336 ms (2.98 FPS) for A06. RSS samples were 54.47 MB and 75.19 MB. The reported CPU sample covers the renderer process around the FFmpeg call; the short-lived FFmpeg child is not claimed as fully measured. No GPU correctness claim is made.

## A06 parameter boundary

The APK declares style_factor as a mutable float with default 0.8. Its semantic meaning is UNKNOWN. Phase 2 parses and preserves the parameter but does not map it to LUT opacity. An explicit non-1 style_factor is rejected by the compiler rather than silently approximated.
