# Sorting V2

- Sort controls: Latest (default), Oldest, Duration (long/short), Resolution (hi/lo), FPS (hi/lo), Size (big/small), Name A-Z / Z-A.
- Data source: probe creationTime -> filename DJI_ timestamp -> mtime; duration / width*height / fps.value / file size; never bare filename order only.
- UNKNOWN fields use stable fallbacks (filename timestamps, then mtime, then zero) and keep a deterministic order.
- Deterministic comparator lives in src/renderer/sort.js (unit tested) and is applied to the camera and local library lists; filters (All/Videos/Photos) still apply before sorting.
- Test coverage: test/sort.test.js (7 tests: latest, duration, resolution, fps, size, name, UNKNOWN fallback).
