const fs = require("node:fs/promises");
const path = require("node:path");
const MEDIA_EXTENSIONS = new Set([".mp4", ".lrf", ".aac", ".jpg", ".jpeg", ".png"]);

class ReadOnlyMediaAccess {
  constructor(options = {}) { this.fs = options.fs || fs; }
  async listMediaFiles(rootPath, options = {}) {
    const results = [];
    await this.walk(path.resolve(rootPath), results, 0, options.maxDepth ?? 12);
    return results.sort((a, b) => a.localeCompare(b));
  }
  async walk(currentPath, results, depth, maxDepth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await this.fs.readdir(currentPath, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) await this.walk(fullPath, results, depth + 1, maxDepth);
      else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) results.push(fullPath);
    }
  }
  async stat(filePath) { return this.fs.stat(filePath); }
}
module.exports = { ReadOnlyMediaAccess, MEDIA_EXTENSIONS };
