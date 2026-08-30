const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { ensureThumbnail, ensurePoster, placeholderState } = require("../src/thumbnail/thumbnail-loader");
const workspaceRoot = path.resolve(__dirname, "..", "..");
const fixture = path.join(workspaceRoot, "dji-test-media");

test("THM is preferred when present, then SCR", async () => { const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dji-th-")); const thm = path.join(cacheRoot, "x.THM"); const scr = path.join(cacheRoot, "x.SCR"); fs.writeFileSync(thm, "thm"); fs.writeFileSync(scr, "scr"); const out = await ensureThumbnail({ assetId: "t1", thmPath: thm, scrPath: scr, previewPath: null, originalPath: null, cacheRoot }); assert.equal(fs.readFileSync(out).toString(), "thm"); const out2 = await ensureThumbnail({ assetId: "t2", thmPath: null, scrPath: scr, previewPath: null, originalPath: null, cacheRoot }); assert.equal(fs.readFileSync(out2).toString(), "scr"); });
test("LRF attached JPEG fallback still works on real fixture", async () => { const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dji-th-")); const out = await ensureThumbnail({ assetId: "fixture-a", previewPath: path.join(fixture, "普通色彩.LRF"), originalPath: path.join(fixture, "普通色彩.MP4"), cacheRoot }); assert.ok(out && fs.existsSync(out)); assert.ok(fs.statSync(out).size > 0); });
test("original first frame fallback when preview missing", async () => { const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dji-th-")); const out = await ensureThumbnail({ assetId: "fixture-b", previewPath: null, originalPath: path.join(fixture, "普通色彩.MP4"), cacheRoot }); assert.ok(out && fs.existsSync(out)); });
test("placeholder states are explicit and never broken images", () => { assert.deepEqual(placeholderState(true), { kind: "PLACEHOLDER", label: "NO_THUMBNAIL" }); assert.deepEqual(placeholderState(false), { kind: "PLACEHOLDER", label: "PREVIEW_UNAVAILABLE" }); });
test("poster prefers SCR over LRF attached", async () => { const posterRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dji-po-")); const scr = path.join(posterRoot, "p.SCR"); fs.writeFileSync(scr, "scr"); const out = await ensurePoster({ assetId: "p1", scrPath: scr, previewPath: path.join(fixture, "普通色彩.LRF"), originalPath: null, posterRoot }); assert.equal(fs.readFileSync(out).toString(), "scr"); });
