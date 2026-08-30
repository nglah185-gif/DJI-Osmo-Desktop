const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ThumbnailLocator } = require("../src/thumbnail/thumbnail-locator");

function fakeDevice() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "dji-locator-")); const dcim = path.join(root, "DCIM", "DJI_001"); const misc = path.join(root, "MISC", "THM", "DJI_001"); fs.mkdirSync(dcim, { recursive: true }); fs.mkdirSync(misc, { recursive: true }); fs.writeFileSync(path.join(dcim, "CLIP_0001_D.MP4"), "x"); fs.writeFileSync(path.join(misc, "CLIP_0001_D.THM"), "x"); fs.writeFileSync(path.join(misc, "CLIP_0001_D.SCR"), "x"); return { root, dcim, misc }; }

test("locator maps basename and folder context to MISC THM and SCR", () => { const device = fakeDevice(); const locator = new ThumbnailLocator(); const result = locator.locate({ original: { path: path.join(device.dcim, "CLIP_0001_D.MP4") } }); assert.equal(result.thm, path.join(device.misc, "CLIP_0001_D.THM")); assert.equal(result.scr, path.join(device.misc, "CLIP_0001_D.SCR")); assert.equal(result.confidence, "HIGH"); });
test("locator returns NONE when MISC companion missing", () => { const device = fakeDevice(); fs.unlinkSync(path.join(device.misc, "CLIP_0001_D.THM")); fs.unlinkSync(path.join(device.misc, "CLIP_0001_D.SCR")); const result = new ThumbnailLocator().locate({ original: { path: path.join(device.dcim, "CLIP_0001_D.MP4") } }); assert.equal(result.thm, null); assert.equal(result.scr, null); assert.equal(result.confidence, "NONE"); });
test("locator ignores non-DCIM paths", () => { const result = new ThumbnailLocator().locate({ original: { path: "C:\\Users\\me\\video.mp4" } }); assert.equal(result.confidence, "NONE"); });
