# Preview UX Fixes (V2)

Verbatim feedback: "加载时加进度条 / 浏览和编辑模式到底有啥区别，没区别就删掉 / 这个视频一直没发正常预览，会卡死，显示出来也是经过拉伸的 / 本地查看就不要生成预览代理了直接播放就好了"

## What changed

### 1. Loading progress bar (fallback proxy generation)
- src/thumbnail/fallback-proxy.js: ffmpeg now runs with -progress pipe:1; out_time_us
  events are parsed and reported through an onProgress(pct) callback. Concurrent
  requests for the same asset are coalesced (inflight map) — previously, fast
  clicking on a 4K slow-mo clip launched several concurrent ffmpeg processes and
  froze the machine (the "卡死").
- src/main/main.js: media:preview-url forwards progress to the renderer via
  media:preview-progress ({assetId, pct}).
- src/preload/preload.js: onPreviewProgress(cb) bridge.
- src/renderer/renderer-phase3.js + index.html + styles.css: the empty state now
  shows a real progress bar ("正在生成预览代理…" + % + fill bar), with a request
  token so stale responses (user switched clip mid-transcode) are ignored.

### 2. Browse/Edit mode merged (del)
- Removed the header Browse/Edit tabs and the footer Browse/Edit toggle (they were
  duplicates). One preview works for both: playback uses the LRF (or fallback /
  original); touching any color/watermark/transform control renders the live effect
  frame automatically. A state badge shows what you are looking at: Proxy LRF /
  Original (fallback proxy) / Original (direct), and "● Live effects" while the
  effect frame is shown. Play button in edit state returns to video.

### 3. Stretched thumbnail / preview fixed
- Root cause: the 0370 slow-mo clip's camera THM is 90x160 portrait while the card
  thumbnail box is 104x62 landscape; object-fit: cover on an unconstrained img let
  the image overflow (displayed height 184px, content cropped into a stretched band).
- styles.css: .thumb img { position:absolute; inset:0; width/height:100%;
  max-width/max-height:100%; object-fit:cover } — verified imgBox = 104x62.
- The fallback proxy scale filter was ALSO aspect-unsafe for portrait sources
  (per-axis min() distorted the picture). Replaced with
  scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1
  — letterboxed, never stretched. Verified 0370 -> 640x360 h264, preview plays true.

### 4. Local library plays original directly (no proxy)
- src/main/main.js: media:preview-url checks asset.source === "local" (or localCatalog
  hit) → authorizes the ORIGINAL file path and returns dji-media://asset/original/<id>
  with sourceType ORIGINAL — no transcode.
- dji-media protocol gained the original route (authorizedOriginalPaths map).
- Renderer shows "Original (direct)" as the proxy label for local assets.

## Verification
- Real device (F:) UI: opened 0370 slow-mo — progress 2%→99% → plays at 640x360
  true 16:9 (no stretch), badge "Original (fallback proxy)"; second open <1s (cache).
- Card thumbnails now fit exactly 104x62 (was 104x184 overflow).
- npm test: 92/92 green.
