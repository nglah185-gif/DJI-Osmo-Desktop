# Phase 3.5 UX Fixes V2

## Scope

This phase repairs incomplete interactions in the existing Phase 3 workspace. No new filters, watermark workflows, timeline features, or transport protocols were added.

## Fixes

| Issue | Implementation | Status |
|---|---|---|
| LRF cards showed placeholders | Main process extracts the attached JPEG stream (`0:v:1`) with FFmpeg into a local user-data thumbnail cache. The renderer uses the cached image through `dji-media://thumbnail/<assetId>`. | PARTIAL |
| Browse looked playable but did not play | Card selection opens Browse, loads the authorized LRF URL, calls `HTMLMediaElement.play()`, and binds controls to `loadedmetadata`, `timeupdate`, `play`, and `pause`. | PASS |
| Playback state was duplicated | The renderer keeps one playback state object and updates it from native video events. | PASS |
| Library scroll moved preview | Workspace height is bounded to the window; only `.library-panel` scrolls vertically. Storage and preview panels are clipped. | PASS |
| Scan status jumped without context | Pipeline emits stage/count events and main forwards `media:scan-progress` to the renderer. | PARTIAL |

## Verification

- Existing automated tests should be run with the repository's normal test command.
- Thumbnail extraction requires an FFmpeg build that can decode the LRF attached MJPEG stream. If extraction fails, the card retains the LRF fallback label.
- Incremental asset rendering during the scan is not yet implemented; the snapshot is still published after probing and pairing complete.

## Non-claims

This work does not infer D-Log M from metadata and does not claim that LRF and Original have identical color semantics.
