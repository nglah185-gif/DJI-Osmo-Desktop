# Live Effect Preview V2

- All live effects flow through the same EffectGraph consumed by both the frame renderer and the export renderer (identical resource ids, hashes, parameters, order).
- Controls (color profile, technical transform, creative look, watermark enable/style/position/scale/opacity, speed, rotate, crop, flips) trigger a debounced edit-frame re-render (130 ms) in Edit mode, so selecting D-Log M, Forest Pro, or a watermark position changes the frame immediately.
- Watermark overlays are now actually rendered by filter-graph-builder: looped image input, colorchannelmixer opacity, scale, and normalized-position overlay expressions; previously the overlay stage was a no-op.
- Verified: unit tests assert the chain order technical -> creative -> watermark and that position changes alter the expression; CDP run confirms frame bytes change on watermark enable and on top-left vs center position.
