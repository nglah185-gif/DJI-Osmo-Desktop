# Preview Fallback V2

- Source identity now has four states: LRF_PROXY, ORIGINAL_FALLBACK, LRF_EDIT_PREVIEW, ORIGINAL (export).
- Browse with LRF plays LRF_PROXY. Browse without LRF builds a downscaled h264 proxy (<=960x540, cached under userData/cache/fallbacks) and plays it as ORIGINAL_FALLBACK. Preview is only unavailable when decode itself fails.
- Edit preview uses the LRF when present, otherwise the same fallback proxy; it never silently edits the original files.
- AAC stays an external candidate; fallback never merges audio.
- Verified: fallback proxy generation on 高帧率.MP4 (real fixture), cache hit, decodable and downscaled; source type assertions in test/preview-fallback.test.js.
- Note: 4K slow-motion sources take minutes for the first fallback build (large transcode); the result is cached.
