# MediaAsset Media Roles V2

## Roles per MediaAsset

- original: the MP4 (primary identity, file name shown on the card, Export source).
- preview: the LRF (Browse playback and Edit interaction preview; never modified, never an independent card, never counted separately).
- externalAudioCandidates: AAC companions; sync status stays UNKNOWN; never auto-merged.
- thumbnail: MISC THM (160x90) for the Media Library list.
- poster: MISC SCR (1280x720) for the selected media preview before playback starts.
- MISC THM/SCR without a matching Original are ORPHAN_THUMBNAIL; LRF without Original is ORPHAN_PROXY. Neither enters the main Media Library nor the counts.

## Counts on the real device

- DCIM\DJI_001: 85 MP4, 78 LRF (7 unmatched). MISC\THM\DJI_001: 368 THM + 368 SCR; 85 of them match the current MP4s (85/85), the remaining 283 are historical leftovers excluded from the library.
- Media Library count = MediaAsset count (85), derived from MediaCatalog, never hard-coded.

## Slow-motion identification

- Rule: a clip whose preview is UNKNOWN but which has a companion AAC (same basename, no LRF) is classified captureMode = SLOW_MOTION with evidence reason no-lrf-with-aac. DJI slow-motion captures store audio as a separate AAC and omit the LRF companion; this was verified on the real card (all 7 no-LRF MP4s have a matching AAC, and DCIM contains exactly 7 AAC files), and the fps check confirms the theory is not frame-rate based (all no-LRF clips are 29.97).
- Slow-motion assets still export from Original MP4 and still show MISC THM cards; only Browse/Edit preview are unavailable (per source-identity rules).
- Fixture coverage: 高帧率.MP4 + 高帧率.AAC (no LRF) is classified SLOW_MOTION; 普通色彩 (with LRF) is STANDARD.

## Source identity

- Browse = MediaAsset.preview (LRF_PROXY).
- Edit preview = MediaAsset.preview (LRF_EDIT_PREVIEW), operations stored as EffectGraph.
- Export = MediaAsset.original (ORIGINAL MP4) with the same EffectGraph re-executed.
- Thumbnail (card) = THM; Poster (preview before play) = SCR; the three duties never mix.
