# MediaAsset Final Model V2

## Aggregation

- foo.MP4 + foo.LRF + foo.AAC = one MediaAsset.
- The library renders MediaAssets only; LRF never appears as its own card, name, or count.
- AAC never appears in the library; it attaches as externalAudioCandidates with sync status UNKNOWN (no auto-play or merge).
- Asset shape: original (MP4), preview (LRF or UNKNOWN), externalAudioCandidates[], thumbnail metadata, timing, displayGeometry, colorDeclaration, pairingEvidence.

## Source identity

- BROWSE = asset.preview (LRF_PROXY).
- EDIT preview = asset.preview (LRF_EDIT_PREVIEW) - edit preview renders from the LRF and never modifies it or the MP4.
- EXPORT = asset.original (ORIGINAL MP4) - the EffectGraph from the edit session is re-executed on the original for export. This is non-destructive editing.
- When preview is UNKNOWN, Browse shows Preview unavailable and Edit refuses with an explicit error; there is no silent preview-to-original fallback.

## Counting

- file-count and the library summary use snapshot.assets.length (MediaAsset count), never a sum of MP4+LRF+AAC files and never a hard-coded number.
- Earlier 89 vs 85 discrepancy: the pipeline unconditionally injected the offline sample root. With a camera present, the sample root is now suppressed, so the connected Action 4 reports its own 85 assets; the four offline fixtures appear only when no camera is present (the offline test suite still covers them).
