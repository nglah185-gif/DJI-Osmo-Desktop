const fs = require("node:fs");
const path = require("node:path");
class ConfigStore {
  constructor(options) { this.filePath = options.filePath; this.defaults = options.defaults || {}; this.data = Object.assign({}, this.defaults); this.lastLoadError = null; this.load(); }
  load() { try { this.data = Object.assign({}, this.defaults, JSON.parse(fs.readFileSync(this.filePath, "utf8"))); this.lastLoadError = null; } catch (error) { this.data = Object.assign({}, this.defaults); if (error.code !== "ENOENT") this.lastLoadError = error; } return this.data; }
  get(key) { return this.data[key]; }
  set(key, value) { const previous = this.data[key]; this.data[key] = value; try { this.save(); } catch (error) { this.data[key] = previous; throw error; } return value; }
  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = this.filePath + ".tmp-" + process.pid;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), "utf8");
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw error;
    }
  }
}
module.exports = { ConfigStore };
