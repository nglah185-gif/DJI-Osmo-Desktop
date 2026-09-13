# Phase 3 Editor Implementation

- Browse Preview uses paired LRF playback.
- Edit Preview decodes Original MP4, downscales to 1280x720, and applies the shared EffectGraph.
- The editor is single-track and uses microseconds for `sourceInUs`, `sourceOutUs`, and `timelineInUs`.
- D-Log M is user-selected only. Normal uses no technical transform.
- Forest Pro, Ice Pro, and Nature Pro are official Rec.709 creative looks after the technical transform.
- Export uses Original MP4 and H.264/AAC.

Excluded: APK styles/effects, DUML, SWUDP, FPV, AI, and multi-track editing.
