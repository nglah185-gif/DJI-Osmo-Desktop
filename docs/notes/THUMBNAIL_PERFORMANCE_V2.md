# Thumbnail Performance V2

## Measurement environment

- Real DJI Osmo Action 4 connected (F:\\), 85 MediaAssets (85/85 THM+SCR paired), first run after cache reset.
- Measured through a live Chrome DevTools Protocol session; numbers below are the recorded run (artifacts/thumbnail-benchmark.json).

## Results

| Metric | Result |
|---|---:|
| Initial MediaAsset render (layout of first window) | 3 ms |
| First visible thumbnail latency | 3 ms |
| Visible thumbnail completion (9 visible cards) | 3 ms |
| Peak concurrent thumbnail tasks (sampled) | <= 3 (configured limit; sampled peak 1 because tasks complete in milliseconds) |
| Scroll frames per second (rAF sample, 1 s) | 77 |
| Cache hit ratio on window | 19 / 21 completed = 90% (after one warm pass) |
| Renderer JS heap during measurement | ~ consistent, no growth observed across 40 samples |
| Thumbnail stats row at settle | Visible 9 - Requested 42 - Loading 1 - Loaded 21 - Cache Hit 20 - Error 0 (first pass generates, repeats hit) |
| Static settle after first paint | 11 cards, 11 images, 0 placeholders (no flash) |
| Instant scroll down 10 rows | 13 cards, 13 images, 0 placeholders (prefetched ahead) |
| Rapid continuous scroll (20 jumps x 3 rows every 40 ms) | every step shows 11 cards, 11 images, 0 placeholders; scrollTop advances 0 -> 5280 px with zero waiting (node reuse + rAF paint + prefetch 20) |
| Requests to cross the whole rapid-scroll run | 31 requests total, 30 loaded, 0 errors, deduped by token |

## Notes

- THM/SCR copies are the dominant fast path (no ffmpeg frame extraction needed on DJI cards); ffmpeg extraction remains the fallback chain for non-DJI or missing-companion assets.
- 22 requests correspond to the window (12) plus scroll overscan repaints during the sampling loop; queued far tasks remain cancellable via scheduler cancelBelow.
- Cache directory: %APPDATA%\dji-osmo-desktop-v2\cache\{thumbnails,posters}.
