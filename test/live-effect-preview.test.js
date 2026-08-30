const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFilterGraph } = require("../src/renderers/filter-graph-builder");
const { createEffectGraph } = require("../src/color/effect-graph");
function graphWith(overrides) { return createEffectGraph(Object.assign({ colorTransform: { kind: "technical-color", enabled: true, colorProfile: { technicalTransformId: "a4", technicalTransformSha256: "aa", cameraFamily: "Osmo Action" } }, styleStack: [{ resourceId: "creative" }], overlays: [{ kind: "image", path: "C:/wm.png", enabled: true, position: "bottomRight", scale: 0.2, opacity: 0.8 }] }, overrides)); }
test("live graph renders technical, creative look and watermark in one filter chain", async () => {
  const lutRegistry = { get: id => { if (id === "a4") return { format: "CUBE", path: "C:/a4.cube", availability: "OFFICIAL_PIPELINE", role: "TECHNICAL_TRANSFORM", cameraFamily: "Osmo Action", sha256: "aa" }; if (id === "creative") return { format: "CUBE", path: "C:/c.cube", availability: "OFFICIAL_PIPELINE", role: "CREATIVE_LOOK", inputColorSpace: "Rec.709", outputColorSpace: "Rec.709" }; return null; } };
  const styleRegistry = { load: async () => ({ resources: [] }) };
  const built = await buildFilterGraph({ graph: graphWith(), lutRegistry, styleRegistry, cacheRoot: "C:/tmp" });
  const idxTech = built.filterGraph.indexOf("a4.cube");
  const idxStyle = built.filterGraph.indexOf("c.cube");
  const idxOverlay = built.filterGraph.indexOf("colorchannelmixer=aa=0.8000");
  const idxOv = built.filterGraph.indexOf("overlay=");
  assert.ok(idxTech >= 0 && idxStyle > idxTech, "technical precedes creative");
  assert.ok(idxOverlay > idxStyle, "watermark after color stages");
  assert.ok(idxOv > idxOverlay);
  assert.match(built.filterGraph, /main_w/);
});
// The official badge is anchored to a single reference framing (ink centre at
// 93% of frame height, horizontally centred). Legacy corner presets must not be
// able to move it off that line, so the graph is position-independent by design.
test("watermark placement is fixed bottom-centre regardless of legacy position preset", async () => {
  const lutRegistry = { get: () => null }; const styleRegistry = { load: async () => ({ resources: [] }) };
  const base = { styleStack: [] };
  const left = await buildFilterGraph({ graph: graphWith(Object.assign({}, base, { overlays: [{ kind: "image", path: "C:/wm.png", enabled: true, position: "topLeft", scale: 0.2, opacity: 1 }] })), lutRegistry, styleRegistry, cacheRoot: "C:/t" });
  const right = await buildFilterGraph({ graph: graphWith(Object.assign({}, base, { overlays: [{ kind: "image", path: "C:/wm.png", enabled: true, position: "bottomRight", scale: 0.2, opacity: 1 }] })), lutRegistry, styleRegistry, cacheRoot: "C:/t" });
  assert.equal(left.filterGraph, right.filterGraph);
  // Horizontally centred, and the ink CENTRE (not an edge) sits on the 93% line.
  assert.match(left.filterGraph, /overlay=x=\(main_w-overlay_w\)\/2:y=\(0\.9300\*main_h-overlay_h\/2\)/);
});

// Width is a ratio of the frame, and height is derived from the ink aspect, so
// the badge keeps one visual size and one aspect on every source resolution.
test("watermark is sized from frame width with the ink aspect preserved", async () => {
  const lutRegistry = { get: () => null }; const styleRegistry = { load: async () => ({ resources: [] }) };
  const built = await buildFilterGraph({ graph: graphWith({ styleStack: [], overlays: [{ kind: "image", path: "C:/wm.png", enabled: true, scale: 0.195, opacity: 1 }] }), lutRegistry, styleRegistry, cacheRoot: "C:/t" });
  // Transparent padding cropped away before sizing.
  assert.match(built.filterGraph, /crop=774:72:3:108/);
  // 72/774 = 0.0930232...; 0.195 * that = 0.0181395 -> 0.018140 at 6 decimals
  // Even-rounded, not truncated: trunc floors, which strips a disproportionate
  // share of the badge height on small frames (1080x1920 wants h=19.6, 640x360
  // wants 11.6) and distorts the 10.75:1 glyph aspect.
  assert.match(built.filterGraph, /scale2ref=w=round\(iw\*0\.1950\/2\)\*2:h=round\(iw\*0\.018140\/2\)\*2/);
});

test("fractional crop keeps export dimensions encoder-safe", async () => {
  const { buildFilterGraph } = require("../src/renderers/filter-graph-builder");
  const result = await buildFilterGraph({
    graph: { displayGeometry: { crop: { left: 0.12, top: 0, right: 0, bottom: 0 } } },
    lutRegistry: { get: () => null }
  });
  assert.match(result.filterGraph, /scale=trunc\(iw\/2\)\*2:trunc\(ih\/2\)\*2/);
});
