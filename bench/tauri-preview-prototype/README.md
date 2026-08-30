# Rust preview-path benchmark

This isolated Phase 4.6 prototype reads the real preview source through FFmpeg,
applies the same LUT/watermark classes as the Electron application, and consumes
complete RGB24 frames in Rust. It does not modify the production application.

The benchmark intentionally reports the Rust/FFmpeg frame boundary separately
from WebView2. A full Tauri display build is recorded as available or unavailable
in `TAURI_PREVIEW_PROFILE_V2.md`; unavailable measurements are never inferred.
