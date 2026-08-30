# Human UI QA V2 (Phase 3.5.x Native Thumbnails)

## Automated evidence (this run)

- npm test: 58 pass, 0 fail (aggregation, locator, priority chain, cache hit/invalidation, poster separation, scheduler concurrency/priority/cancellation, virtual window).
- Real device: library 85 MediaAssets; cards render from official MISC THM thumbnails; stats row shows Visible 9 / Requested 22 / Loading 1 / Loaded 2 / Cache Hit 19 / Error 0; first visible thumbnail at 3 ms; scroll ~77 FPS.
- Selected clip poster served from MISC SCR via dji-media://asset/poster/<id>; video takes over when playable (canplay).
- No broken image states; placeholder is a styled label.
- Cache dirs under %APPDATA%\dji-osmo-desktop-v2\cache\thumbnails and \posters; camera storage untouched (read-only).

## Human checklist (still to perform)

1. Scan connected Action 4; header shows DJI Osmo Action 4 / HG302.
2. Library lists 85 aggregated cards; no LRF/AAC/THM/SCR independent cards.
3. Card thumbnails are real pictures and update instantly as the list scrolls.
4. Select a clip: SCR poster appears briefly, then the LRF plays.
5. Seek, play/pause, Edit preview, Watermark and Look controls still behave as before.
6. Export an edited clip and confirm the output file.
