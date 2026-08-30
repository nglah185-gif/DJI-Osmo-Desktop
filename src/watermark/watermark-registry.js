const path = require("node:path"); const crypto = require("node:crypto"); const fs = require("node:fs");
const { InkBoxCache } = require("./watermark-ink-box");
class WatermarkRegistry {
  // inkBoxCache measures each badge's visible glyph box from its own alpha
  // channel. Padding differs per asset, so a shared hardcoded box produces an
  // out-of-bounds crop and fails the whole ffmpeg graph for most styles.
  constructor({ inkBoxCache = null } = {}) { this.entries = new Map(); this.inkBoxCache = inkBoxCache; }
  register(entry) { if (!entry.id || !entry.path) throw new Error("Watermark id and path are required"); const sha256 = crypto.createHash("sha256").update(fs.readFileSync(entry.path)).digest("hex").toUpperCase(); this.entries.set(entry.id, Object.freeze({ kind: "image", source: "DJI_OFFICIAL_ASSET", ...entry, sha256 })); return this.entries.get(entry.id); }
  get(id) { return this.entries.get(id) || null; }
  list() { return [...this.entries.values()]; }
  forCameraModel(cameraModel) { const family = familyForCameraModel(cameraModel); return this.list().filter(entry => entry.cameraFamily === family); }
  // Returns the cached ink box if it has already been measured, else null. Kept
  // synchronous so graph building never blocks; callers prime the cache first.
  inkBoxFor(id) { const entry = this.get(id); return entry && this.inkBoxCache ? this.inkBoxCache.get(entry.sha256) : null; }
  // Measure on demand and remember the result, keyed by content hash so a
  // replaced asset is re-measured automatically.
  async ensureInkBox(id) {
    const entry = this.get(id);
    if (!entry || !this.inkBoxCache) return null;
    return this.inkBoxCache.resolve(entry);
  }
}
const WATERMARK_FAMILIES = [
  ["Action6", "oa6", "DJI Osmo Action 6"], ["Action5Pro", "oa5pro", "DJI Osmo Action 5 Pro"],
  ["Action4", "oa4", "DJI Osmo Action 4"], ["Action3", "oa3", "DJI Osmo Action 3"],
  ["Pocket4Pro", "op4p", "DJI Osmo Pocket 4 Pro"], ["Pocket4", "op4", "DJI Osmo Pocket 4"],
  ["Pocket3", "op3", "DJI Osmo Pocket 3"], ["Action", "on1", "DJI Osmo Action"]
];
function familyForCameraModel(cameraModel) {
  const value = String(cameraModel || "").toLowerCase().replace(/[\s_-]+/g, "");
  if (/action6|oa6/.test(value)) return "Action6";
  if (/action5|oa5pro/.test(value)) return "Action5Pro";
  if (/action4|oa4|hg302/.test(value)) return "Action4";
  if (/action3|oa3/.test(value)) return "Action3";
  if (/pocket4pro|op4p/.test(value)) return "Pocket4Pro";
  if (/pocket4|op4/.test(value)) return "Pocket4";
  if (/pocket3|op3/.test(value)) return "Pocket3";
  if (/action|on1/.test(value)) return "Action";
  return null;
}
function createWatermarkRegistry(root, { cacheRoot = null, inkBoxCache = null } = {}) {
  // Measuring every shipped badge up front would spawn one ffmpeg per asset at
  // startup, so measurement stays lazy and is cached by hash on disk.
  const registry = new WatermarkRegistry({ inkBoxCache: inkBoxCache || new InkBoxCache({ cacheRoot }) });
  const watermarkRoot = path.join(root, "watermark");
  for (const [cameraFamily, token, name] of WATERMARK_FAMILIES) {
    const files = fs.existsSync(watermarkRoot) ? fs.readdirSync(watermarkRoot).filter(file => new RegExp("^pic_watermark_" + token + "_(?:[1-3]|borderless)\\.png$", "i").test(file)).sort() : [];
    for (const file of files) { const suffix = file.replace(new RegExp("^pic_watermark_" + token + "_", "i"), "").replace(/\.png$/i, ""); const id = cameraFamily.toLowerCase() + ".official." + token + (suffix === "1" ? "" : "." + suffix); registry.register({ id, name: name + " " + suffix, cameraFamily, path: path.join(watermarkRoot, file) }); }
  }
  return registry;
}
module.exports = { WatermarkRegistry, createWatermarkRegistry };
