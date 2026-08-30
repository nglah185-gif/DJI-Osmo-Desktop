# Player Interaction V2

Browse uses the native HTML video element. Metadata, time updates, play, pause, seek, and duration are sourced from the element. The range input writes `video.currentTime` in seconds, and keyboard Space/Arrow controls call native play/pause and seek operations. No timer-based playback is used.
