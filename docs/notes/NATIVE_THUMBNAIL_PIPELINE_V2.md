# Native Thumbnail Pipeline V2

## ThumbnailLocator

- src/thumbnail/thumbnail-locator.js resolves MISC companions from a MediaAsset original path using basename + folder + device context: F:\\DCIM\\DJI_001\\<base>.MP4 -> F:\\MISC\\THM\\DJI_001\\<base>.THM / <base>.SCR, returning { thm, scr, confidence: HIGH | NONE }.
- Extensible by design (no hard-coded assumption that every camera uses identical rules; the locator derives folder context from the actual path).
- MISC resources never enter Media Library; only assets whose original exists are listed.

## Extraction priority

List thumbnail chain: THM (160x90 MJPEG) -> SCR (1280x720 MJPEG) -> LRF attached JPEG -> LRF first frame -> Original first frame -> Placeholder.
Poster chain (selected media): SCR -> LRF attached JPEG -> LRF first frame -> Original first frame -> Placeholder.
THM and SCR are copied verbatim (they are JPEG containers) into the local cache, so a cold card still shows official DJI thumbnails without frame extraction.

## Caching

- userData\\cache\\thumbnails for list thumbnails and userData\\cache\\posters for posters (never writes the camera, SD card, MISC, or DCIM).
- Cache key is the MediaAsset id (path + size + mtime signature), so renamed or re-recorded clips are invalidated naturally.

## Streaming and concurrency

- Only viewport + overscan cards are rendered; only those cards request thumbnails.
- Prefetch: after every window paint the next 10 assets below the window are prefetched into an in-page thumbnail cache (priority 0), so scrolling down renders instantly.
- Frozen-image repaint: paintGrid reuses the in-page cache (assetId -> URL) to build cards with an img directly, so scrolling never flashes placeholder-first; a task whose DOM node was replaced schedules one repaint (debounced 60 ms) instead of being lost.
- ThumbScheduler (src/thumbnail/thumb-scheduler.js, isomorphic) keeps peak concurrency <= 3, runs visible-row tasks at priority 2 before overscan at priority 1, supports cancelling far-off queued tasks, dedupes by token (queued or active), and reports requested/started/loading/loaded/cacheHit/error stats surfaced in the UI debug row.
- cacheHit is evaluated against the resolved cache path before generation, so first generation counts as loaded and repeats as cacheHit.
- State machine: NOT_REQUESTED -> REQUESTED -> LOADING -> LOADED; failure falls through the chain to Placeholder; broken browser images never appear.

## Verified on the real Action 4

- Cache dirs populated: cache/thumbnails and cache/posters.
- Poster URL served: dji-media://asset/poster/<id> after selecting a real clip.
- Thumbnail stats row: Visible 9 - Requested 22 - Loading 1 - Loaded 2 - Cache Hit 19 - Error 0 (window cache efficiency; cold load then cache-hits on repeat).
