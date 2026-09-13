# Timeline Interaction V2

- Timeline math extracted to src/renderer/timeline-math.js (clampTimeToRange, ratioToSeconds, trimSeconds, trimFromEvent) and unit tested.
- Playhead follows video.currentTime; dragging the timeline track seeks the preview (clamped inside Trim range in edit mode).
- Trim Start / Trim End handles update sourceIn/sourceOut in real time (Trim Start / Trim End labels in English; 剪辑开始 / 剪辑结束 in Simplified Chinese).
- Editing-time clamping keeps the playhead inside the trim range during playback.
- Speed 0.5x/1x/2x participates in the same graph and is honored by preview and export.
- CDP smoke confirms seeking and trim handle interactions remain functional after the refactor; unit tests enforce clamping semantics.
