const path = require("path");
const { buildFilterGraph } = require("../src/renderers/filter-graph-builder");

(async () => {
  const graph = {
    sourceTransform: { enabled: true },
    displayGeometry: { enabled: false },
    colorTransform: { enabled: false },
    styleStack: [],
    adjustments: [],
    overlays: [{ enabled: true, kind: "image", path: process.argv[2], scale: 0.195, opacity: 1 }]
  };
  const r = await buildFilterGraph({ graph, lutRegistry: { get: () => null }, styleRegistry: null, cacheRoot: null });
  console.log(JSON.stringify({ filterGraph: r.filterGraph, inputArgs: r.inputArgs }));
})().catch(e => { console.error("ERR " + e.message); process.exit(1); });
