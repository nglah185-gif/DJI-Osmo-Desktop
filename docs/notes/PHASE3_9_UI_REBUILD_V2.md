# Phase 3.9 UI Rebuild V2

## Design baseline

The user-provided reference screenshot is now the visual baseline. It shows: compact header with Browse/Edit navigation, centered device title, language selector with globe icon and settings gear; Media Library with a Media Library heading, Scan completed / file count / Rescan row, All/Videos/Photos filter tabs, and list-style cards (thumbnail left, name, duration/resolution/fps, codec, 10-bit and LRF badges); center preview with transport controls and a footer row (Browse/Edit tabs, Proxy LRF (720p), Fit); right inspector as an accordion (Color, Adjustments, Timeline, Watermark) with Color Profile / Technical Transform / Creative Look fields and a full-width blue Export primary button.

## Implementation match

- Header: brand, Browse/Edit nav tabs, centered DJI Osmo Action 4 / HG302 title, language selector, settings gear (settings shows an explicit not-available notice; no fake settings).
- Library: Media Library title, Scan completed + real file count + Rescan, filter tabs with real counts (Videos = MediaAsset count, Photos = 0 because the media access layer is video-only by design, All = sum; reference 512/224 numbers are mock data and are not hard-coded), virtualized list cards with real thumbnail, name, duration, resolution, fps, codec, 10-bit, LRF badges.
- Preview: transport (prev, SVG play/pause, next, timecodes, pointer-seek bar) and footer row with Browse/Edit mode tabs, real Proxy LRF (<height>p) label, Fit/Contain/Cover selector.
- Inspector: accordion with Color (Color Profile / Technical Transform / Creative Look), Adjustments (Speed/Rotate/Crop/Flip), Timeline (trim In/Out, one-track strip with playhead and trim handles), Watermark (Style/Scale/Opacity); export facts; blue Export primary CTA.
- English and Simplified Chinese complete.

## Critical bug fixed: seek was impossible

dji-media protocol did not implement HTTP byte ranges. Video seek triggered a Range request which was answered with a full 200 response, so the browser reloaded the stream from the beginning and currentTime reset to 0. The protocol handler now serves 206 responses with Content-Range/Accept-Ranges via a streamed read, so seeking and dragging work. Verified on the real camera clip: while playing, setting currentTime=5 held and continued (5.93s after 0.9s), and a pointer drag to 75% landed at 10.94s of 13.888s.

## Other fixes found during reference match

- data-i18n on a container with dynamic children deleted those children on apply (filter counts vanished); keys were moved to inner spans.
- Media list uses window-driven thumbnail loading (IntersectionObserver does not fire in this renderer; verified by probe).
