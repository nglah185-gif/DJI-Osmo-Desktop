# Preview Renderer V2

Browse remains the responsive LRF video path. Edit Preview renders Original MP4 at 1280x720 through the same EffectGraph used by export. On Windows it requests FFmpeg automatic hardware acceleration and records `AUTO_HARDWARE_OR_SOFTWARE`; GPU telemetry is reported as unavailable until a stable provider is introduced. CPU timing, FPS, and RSS are returned per edit frame.
