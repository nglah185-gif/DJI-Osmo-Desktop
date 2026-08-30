# Real Player V2

## Behavior

- HTMLVideoElement is the single playback source; currentTime, duration, paused, ended, seeking and seeked are all read from it.
- Play calls video.play(), Pause calls video.pause(); the button reflects video.paused and swaps inline SVG icons.
- Seek track handles pointerdown/move/up with pointer capture; ratio is mapped to video.currentTime = ratio * duration (player-math.js, unit tested).
- Time display and timeline metadata come from currentTime/duration; the playhead position uses the same ratio; the timeline clip block reflects sourceIn/sourceOut trim handles.
- No fake timers, no setInterval playback, no derived times.

## Source rules

- Browse: LRF_PROXY only.
- Edit: LRF_EDIT_PREVIEW only (rendered from the LRF companion with the current EffectGraph).
- Export: ORIGINAL MP4 with the same EffectGraph re-executed.

## Verified

- Live CDP interaction on the real Action 4: after opening the first asset, debug showed Mode: BROWSE | Source: DJI_20260712172028_0001_D.LRF | Type: LRF_PROXY; video reported playing with currentTime 3.77 and duration 13.89; seek fill matched. Edit mode produced a rendered PNG frame with type LRF_EDIT_PREVIEW and no errors.
