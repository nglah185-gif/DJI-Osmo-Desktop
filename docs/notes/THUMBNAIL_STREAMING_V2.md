# Thumbnail Streaming V2

## Extraction layers

1. LRF attached JPEG (stream -map 0:v:1).
2. LRF first frame (-ss 0.5).
3. Original MP4 first frame (-ss 0.5).
4. Placeholder - shown as a styled label, never a broken image icon.

## Delivery

- Thumbnails are extracted lazily: the renderer requests media:thumbnail-url for a visible card, the main process extracts (or reuses cache) and returns a URL, and the page swaps the placeholder for the img. Nothing is extracted for cards that never enter the window.
- Window-driven loading replaces IntersectionObserver: in this Electron renderer the observer callbacks do not fire (verified with a probe), so paintGrid enqueues thumbnails only for cards inside the computed window. Concurrency is capped (4) with a queue.
- Cache lives under Electron userData thumbnail-cache keyed by MediaAsset id (the id already includes path + size + mtime, i.e. a source signature). Camera, SD card, and source code directories are never written.

## Verified fixes

- dji-media:// URL bug: thumbnail served as dji-media://thumbnail/<id> parsed thumbnail as the host, so images fetched the LRF preview and failed to decode; the URL is now dji-media://asset/thumbnail/<id> and loading succeeds (1280x720 image confirmed through CDP).
- Scan no longer blocks on extracting 85 thumbnails; it publishes the snapshot immediately and thumbnails stream in per visible card.
