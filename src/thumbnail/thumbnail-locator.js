const fs = require("node:fs");
const path = require("node:path");

class ThumbnailLocator {
  constructor(options = {}) {
    this.exists = options.exists || ((filePath) => { try { fs.accessSync(filePath); return true; } catch { return false; } });
  }
  locate(asset) {
    const originalPath = asset && asset.original && asset.original.path;
    if (!originalPath) return { thm: null, scr: null, confidence: "NONE" };
    const deviceRoot = this.findDeviceRoot(originalPath);
    const rel = path.relative(deviceRoot || path.parse(originalPath).root, originalPath);
    const parts = rel.split(path.sep);
    const dcimIndex = parts.findIndex(part => part.toUpperCase() === "DCIM");
    if (dcimIndex < 0 || parts.length < dcimIndex + 3) return { thm: null, scr: null, confidence: "NONE" };
    const folder = parts[dcimIndex + 1];
    const base = path.basename(originalPath, path.extname(originalPath));
    const miscRoot = deviceRoot ? path.join(deviceRoot, "MISC", "THM", folder) : path.join("MISC", "THM", folder);
    const thm = path.join(miscRoot, base + ".THM");
    const scr = path.join(miscRoot, base + ".SCR");
    const hasThm = this.exists(thm);
    const hasScr = this.exists(scr);
    return { thm: hasThm ? thm : null, scr: hasScr ? scr : null, confidence: hasThm || hasScr ? "HIGH" : "NONE" };
  }
  findDeviceRoot(originalPath) {
    const normalized = path.normalize(originalPath);
    const dcim = normalized.indexOf(path.sep + "DCIM" + path.sep);
    if (dcim < 0) return null;
    return normalized.slice(0, dcim + 1);
  }
}

module.exports = { ThumbnailLocator };
