# Watermark Position V2

- Five presets: Top Left, Top Right, Center, Bottom Left, Bottom Right (中文: 左上 / 右上 / 正中 / 左下 / 右下), with normalized coordinates {0..1}x{0..1} and a 4% margin.
- src/watermark/watermark-position.js provides PRESETS, positionFrom, pixelPosition (for tests/preview math) and overlayExpressions (FFmpeg expressions referencing main_w/main_h/overlay dims).
- filter-graph-builder consumes the normalized position and emits margin-aware overlay x/y expressions for both preview and export; enable/scale/opacity are real-time.
- CDP verification: enabling the watermark and switching top-left vs center changes the rendered edit frame immediately.
- Unit tests: preset mapping, margin-aware pixel positions, and expression shape.
