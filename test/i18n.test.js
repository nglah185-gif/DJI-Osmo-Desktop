const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const en = require("../src/i18n/en");
const zh = require("../src/i18n/zh-CN");
const i18n = require("../src/i18n/index");

test("translation registries have matching keys", () => assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort()));
test("english registry is non-empty", () => assert.ok(Object.keys(en).length > 0));
test("translator interpolates variables", () => { const t = i18n.createTranslator("en", en, zh).t; assert.equal(t("media.clipCount", { count: 5 }), "5 clips"); assert.equal(t("scan.files", { current: 3, total: 8 }), "3 / 8 files"); });
test("translator falls back to english then key", () => { const zhMissing = Object.fromEntries(Object.entries(zh).filter(([key]) => key !== "timeline.speed")); const t = i18n.createTranslator("zh-CN", en, zhMissing).t; assert.equal(t("timeline.speed"), "Speed"); assert.equal(t("missing.key.name"), "missing.key.name"); });
test("option translations update native select text and label", () => { const option = { tagName: "OPTION", label: "Old", textContent: "Original" }; i18n.applyElementTranslation(option, "New"); assert.equal(option.label, "New"); assert.equal(option.textContent, "New"); const span = { tagName: "SPAN", textContent: "Old" }; i18n.applyElementTranslation(span, "New"); assert.equal(span.textContent, "New"); });
test("html translation keys all exist in registries", () => { const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8"); const keys = [...html.matchAll(/data-i18n(?:-aria-label|-title)?="([^"]+)"/g)].map(match => match[1]); assert.ok(keys.length > 0); for (const key of keys) assert.equal(en[key] !== undefined, true, "missing key in registry: " + key); });
test("renderer phase3 static keys exist in registries", () => { const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "renderer-phase3.js"), "utf8"); for (const key of ["error.prefix", "media.noThumbnail", "scan.filesLabel", "scan.stage.DETECTING_STORAGE", "export.running", "export.done"]) assert.equal(en[key] !== undefined, true, key); assert.ok(source.includes("scan.filesLabel"), "renderer must translate the files label"); assert.ok(source.includes("ts(\"media.noThumbnail\")") || source.includes("ts('media.noThumbnail')"), "renderer must translate thumbnail placeholder"); });
test("registries expose isomorphic browser globals", () => { const enSource = fs.readFileSync(path.join(__dirname, "..", "src", "i18n", "en.js"), "utf8"); const zhSource = fs.readFileSync(path.join(__dirname, "..", "src", "i18n", "zh-CN.js"), "utf8"); assert.match(enSource, /window\.__I18N_EN__/); assert.match(zhSource, /window\.__I18N_ZH__/); });
test("runtime language changes update the public translator", () => {
  i18n.api.setLanguage("zh-CN");
  assert.equal(i18n.api.t("settings.title"), zh["settings.title"]);
  i18n.api.setLanguage("en");
  assert.equal(i18n.api.t("settings.title"), en["settings.title"]);
});
test("language refresh does not restart browse or edit preview sessions", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "renderer-phase3.js"), "utf8");
  const languageLines = source.split("\n").filter(line => line.includes("language-select") || line.includes("settings-language"));
  assert.ok(languageLines.length > 0);
  assert.doesNotMatch(languageLines.join("\n"), /\b(?:edit|browse|activeAssets|paintGrid)\(\)/);
});
