const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConfigStore } = require("../src/settings/config-store");
test("config store persists language and export location across reloads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dji-cfg-"));
  const file = path.join(dir, "config.json");
  const store = new ConfigStore({ filePath: file, defaults: { language: "en", exportLocation: "" } });
  store.set("language", "zh-CN");
  store.set("exportLocation", "D:\\DJIExports");
  const reloaded = new ConfigStore({ filePath: file, defaults: { language: "en", exportLocation: "" } });
  assert.equal(reloaded.get("language"), "zh-CN");
  assert.equal(reloaded.get("exportLocation"), "D:\\DJIExports");
});
test("missing config falls back to defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dji-cfg-"));
  const store = new ConfigStore({ filePath: path.join(dir, "nope.json"), defaults: { exportLocation: "C:\\Users\\me\\Videos" } });
  assert.equal(store.get("exportLocation"), "C:\\Users\\me\\Videos");
});
test("config store writes atomically without leaving a temporary file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dji-cfg-"));
  const file = path.join(dir, "config.json");
  const store = new ConfigStore({ filePath: file, defaults: { language: "en" } });
  store.set("language", "zh-CN");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).language, "zh-CN");
  assert.equal(fs.existsSync(file + ".tmp-" + process.pid), false);
});
test("malformed config is reported while defaults remain usable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dji-cfg-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, "{broken", "utf8");
  const store = new ConfigStore({ filePath: file, defaults: { language: "en" } });
  assert.equal(store.get("language"), "en");
  assert.ok(store.lastLoadError instanceof Error);
});
