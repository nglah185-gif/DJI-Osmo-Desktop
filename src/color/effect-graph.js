const crypto = require("node:crypto");

const EFFECT_GRAPH_VERSION = 1;
const COLOR_MODES = Object.freeze(["NORMAL", "DLOG_M", "HLG", "UNKNOWN"]);

function createEffectGraph(overrides = {}) {
  return normalizeGraph({
    version: EFFECT_GRAPH_VERSION,
    sourceTransform: { kind: "source", enabled: true },
    displayGeometry: { kind: "display-geometry", enabled: true, rotation: 0, flipHorizontal: false, flipVertical: false, crop: { left: 0, top: 0, right: 0, bottom: 0 } },
    colorTransform: { kind: "technical-color", enabled: false, colorProfile: null, intensity: 1 },
    styleStack: [],
    adjustments: [],
    overlays: [],
    ...overrides
  });
}

function normalizeGraph(graph) {
  const value = { ...graph, version: Number(graph.version || EFFECT_GRAPH_VERSION), styleStack: [...(graph.styleStack || [])], adjustments: [...(graph.adjustments || [])], overlays: [...(graph.overlays || [])] };
  return deepFreeze(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((out, key) => { out[key] = stableValue(value[key]); return out; }, {});
  return value;
}
function serializeEffectGraph(graph) { return JSON.stringify(stableValue(normalizeGraph(graph))); }
function deserializeEffectGraph(serialized) { return normalizeGraph(JSON.parse(serialized)); }
function hashEffectGraph(graph) { return crypto.createHash("sha256").update(serializeEffectGraph(graph)).digest("hex"); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; }

module.exports = { EFFECT_GRAPH_VERSION, COLOR_MODES, createEffectGraph, normalizeGraph, serializeEffectGraph, deserializeEffectGraph, hashEffectGraph };
