# EFFECT_GRAPH_V2.md

## Contract

EffectGraph is a versioned, JSON-serializable description of a color render. Version 1 has stable top-level nodes:

- sourceTransform
- displayGeometry
- colorTransform
- styleStack
- adjustments
- overlays

The graph is normalized before serialization, recursively frozen at runtime, serialized with lexicographically sorted object keys, and hashed with SHA-256. Deserialization uses the same normalization path, so equivalent graphs produce the same bytes and hash.

## Render semantics

The compiler consumes the graph in this order: source, input interpretation, display geometry, technical color transform, Rec.709 working RGB, creative style stack, supported adjustments, overlay stage, and output. Preview and export call the same compiler and differ only in the final FFmpeg output container.

## Phase 2 presets

- Action 4 D-Log M: user-selected DLOG_M ColorProfile and the independently registered APK Hald resource.
- FT_StyleA06: one creative style node using the parsed DJI MIKA atlas resource.
- No other style filters are exposed.

Observed graph hashes from the deterministic implementation:

- Action 4 D-Log M: 8cc0fb3996128f3d1b7010bbafdd51276ecb88250a097737490c92bcdec745c8
- FT_StyleA06: fc0c2e8ac26b7e47f472685fbb1172ebb454189647a30ea79ed42da14a7002a3

Color mode stays UNKNOWN for unverified source media. A codec, filename, or BT.709 tag does not silently select D-Log M.
