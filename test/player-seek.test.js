const test = require("node:test");
const assert = require("node:assert/strict");
const { ratioToSeconds, secondsToRatio, timeToDisplay } = require("../src/renderer/player-math");
const { PREVIEW_MODES, sourceFor } = require("../src/preview/preview-mode");

test("seek ratio maps to video.currentTime through duration", () => { assert.equal(ratioToSeconds(0.5, 10), 5); assert.equal(ratioToSeconds(1.5, 10), 10, "clamped to duration"); assert.equal(ratioToSeconds(-0.1, 10), 0); assert.equal(ratioToSeconds(0.25, 0), 0, "no duration means no seek"); });
test("currentTime maps back to ratio for the timeline", () => { assert.equal(secondsToRatio(5, 10), 0.5); assert.equal(secondsToRatio(12, 10), 1); assert.equal(secondsToRatio(-1, 10), 0); });
test("time display derives from native currentTime and duration", () => { assert.equal(timeToDisplay(13.888), "00:13.888"); assert.equal(timeToDisplay(0.815), "00:00.815"); });
test("browse uses LRF, standard edit uses LRF, export uses original MP4", () => { const asset = { djiColorMode: "Standard", preview: { name: "x.LRF" }, original: { name: "x.MP4" } }; assert.deepEqual(sourceFor(PREVIEW_MODES.BROWSE, asset), { file: asset.preview, type: "LRF_PROXY" }); assert.deepEqual(sourceFor(PREVIEW_MODES.EDIT, asset), { file: asset.preview, type: "LRF_EDIT_PREVIEW" }); assert.deepEqual(sourceFor(PREVIEW_MODES.EXPORT, asset), { file: asset.original, type: "ORIGINAL" }); });
test("edit without LRF uses a directly decodable original", () => { const asset = { preview: "UNKNOWN", original: { name: "x.MP4", probe: { codec: "h264" } } }; assert.deepEqual(sourceFor(PREVIEW_MODES.EDIT, asset), { file: asset.original, type: "ORIGINAL_EDIT_PREVIEW" }); });
