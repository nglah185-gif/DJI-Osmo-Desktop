const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { PREVIEW_MODES, sourceFor } = require("../src/preview/preview-mode");
const { EventEmitter } = require("node:events");
const { ensureFallbackProxy, cancelFallbackProxy } = require("../src/thumbnail/fallback-proxy");
const workspaceRoot = path.resolve(__dirname, "..", "..");
const fixture = path.join(workspaceRoot, "dji-test-media");

test("browse with LRF stays LRF_PROXY", () => { const asset = { preview: { name: "x.LRF" }, original: { name: "x.MP4" } }; assert.equal(sourceFor(PREVIEW_MODES.BROWSE, asset).type, "LRF_PROXY"); });
test("browse without LRF falls back to original as ORIGINAL_FALLBACK", () => { const asset = { preview: "UNKNOWN", original: { name: "x.MP4" } }; const source = sourceFor(PREVIEW_MODES.BROWSE, asset); assert.equal(source.type, "ORIGINAL_FALLBACK"); assert.equal(source.file.name, "x.MP4"); });
test("edit directly decodes a supported original when LRF is missing", () => { const asset = { preview: "UNKNOWN", original: { name: "x.MP4", probe: { codec: "hevc" } } }; assert.deepEqual(sourceFor(PREVIEW_MODES.EDIT, asset), { file: asset.original, type: "ORIGINAL_EDIT_PREVIEW" }); });
test("edit leaves unsupported originals to the fallback proxy pipeline", () => { const asset = { preview: "UNKNOWN", original: { name: "x.MKV", probe: { codec: "vp9" } } }; assert.equal(sourceFor(PREVIEW_MODES.EDIT, asset), null); });
test("fallback proxy is generated for a no-LRF clip and cached", async () => { const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dji-fb-")); const first = await ensureFallbackProxy({ assetId: "slow1", originalPath: path.join(fixture, "高帧率.MP4"), cacheRoot }); assert.ok(first && fs.existsSync(first), "proxy exists"); assert.ok(fs.statSync(first).size > 0); const second = await ensureFallbackProxy({ assetId: "slow1", originalPath: path.join(fixture, "高帧率.MP4"), cacheRoot }); assert.equal(second, first, "cache hit returns same file"); });
test("fallback proxy is decodable and downscaled", async () => { const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dji-fb-")); const proxy = await ensureFallbackProxy({ assetId: "slow2", originalPath: path.join(fixture, "高帧率.MP4"), cacheRoot }); const probe = JSON.parse(require("node:child_process").execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "json", proxy]).toString()); const stream = probe.streams.find(s => s.codec_type !== "audio"); assert.equal(stream.codec_name, "h264"); assert.ok(stream.width <= 960 && stream.height <= 540); });

test("fallback generation can be canceled when the selected asset changes", async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dji-fb-cancel-"));
  const originalPath = path.join(cacheRoot, "source.mp4");
  fs.writeFileSync(originalPath, "source");
  let child;
  const spawnProcess = () => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killCalls = 0;
    child.kill = () => { child.killCalls++; process.nextTick(() => child.emit("close", null)); return true; };
    return child;
  };
  const pending = ensureFallbackProxy({ assetId: "cancel-me", originalPath, cacheRoot, spawnProcess });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelFallbackProxy("cancel-me"), 1);
  assert.equal(await pending, null);
  assert.equal(child.killCalls, 1);
});
