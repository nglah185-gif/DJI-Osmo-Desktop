const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { decodeRgbImage } = require("./hald-lut");
const { decodeMikaAtlas, resampleLut } = require("./mika-lut");

class StyleRegistry {
  constructor() { this.entries = new Map(); }
  register(entry) { if (!entry.id || !entry.configPath) throw new Error("Style id and configPath are required"); this.entries.set(entry.id, Object.freeze({ verificationState: "NOT_VERIFIED", ...entry })); return this.entries.get(entry.id); }
  get(id) { return this.entries.get(id) || null; }
  list() { return [...this.entries.values()]; }
  async load(id) {
    const entry = this.get(id); if (!entry) throw new Error("Unknown style: " + id);
    const config = JSON.parse(await fs.readFile(entry.configPath, "utf8"));
    const filterPath = path.join(path.dirname(entry.configPath), config.filter && config.filter.input || "filter.json");
    const filter = JSON.parse(await fs.readFile(filterPath, "utf8")); const filters = Array.isArray(filter.filter) ? filter.filter : []; const resources = [];
    for (const item of filters) { const resourcePath = item.input ? path.join(path.dirname(filterPath), item.input) : null; if (!resourcePath) continue; const data = await fs.readFile(resourcePath); resources.push({ service: item.service || "UNKNOWN", path: resourcePath, sha256: crypto.createHash("sha256").update(data).digest("hex").toUpperCase(), exists: true }); }
    const parameters = config.filter && Array.isArray(config.filter.parameters) ? config.filter.parameters : [];
    return { ...entry, config, filter, service: config.filter && config.filter.service || "UNKNOWN", parameters, resources, styleFactor: parameters.find(item => item.identifier === "style_factor") || null, verificationState: resources.length ? "CONFIRMED" : "NOT_VERIFIED" };
  }
  async ensureStandardCube(style, resource, cacheRoot) {
    const targetRoot = cacheRoot || path.join(process.cwd(), "artifacts", "generated-luts"); await fs.mkdir(targetRoot, { recursive: true });
    const cubePath = path.join(targetRoot, style.id + "-" + resource.sha256.slice(0, 16) + ".cube");
    try { await fs.access(cubePath); return cubePath; } catch {}
    const image = await decodeRgbImage(resource.path); const atlas = decodeMikaAtlas(image, { source: resource.sha256 }); const lut = resampleLut(atlas, 32);
    const lines = ["# Generated from DJI Mimo mika.lut resource", "# Source SHA-256 " + resource.sha256, "LUT_3D_SIZE " + lut.size, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1", ""]; for (const value of lut.values) lines.push(value.map(channel => channel.toFixed(8)).join(" ")); await fs.writeFile(cubePath, lines.join("\n") + "\n", "utf8"); return cubePath;
  }
}
function createStyleRegistry(workspaceRoot) { const registry = new StyleRegistry(); const root = path.join(workspaceRoot, "dji.mimo", "assets", "DJI-Assets", "filter", "FT_StyleA06"); registry.register({ id: "FT_StyleA06", name: "Style A06", cameraModel: "UNKNOWN", cameraFamily: "Osmo", configPath: path.join(root, "config.json"), verificationState: "NOT_VERIFIED", source: "DJI_MIMO_APK", styleFactorSemantics: "UNKNOWN" }); return registry; }
module.exports = { StyleRegistry, createStyleRegistry };
