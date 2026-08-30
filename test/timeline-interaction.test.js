const test = require("node:test");
const assert = require("node:assert/strict");
const { clampTimeToRange, ratioToSeconds, trimSeconds, trimFromEvent } = require("../src/renderer/timeline-math");
test("playhead clamps inside trim range", () => { assert.equal(clampTimeToRange(2, 3, 10), 3); assert.equal(clampTimeToRange(12, 3, 10), 10); assert.equal(clampTimeToRange(5, 3, 10), 5); });
test("ratio maps to seconds within duration", () => { assert.equal(ratioToSeconds(0.5, 10), 5); assert.equal(ratioToSeconds(1.5, 10), 10); });
test("trim seek clamps to [start,end]", () => { assert.equal(trimSeconds(0.1, 10, 3, 7), 3); assert.equal(trimSeconds(0.9, 10, 3, 7), 7); assert.equal(trimSeconds(0.5, 10, 3, 7), 5); });
test("trim handles keep order and push the other side", () => { const movedStart = trimFromEvent(0.4, 10, true, 7); assert.equal(movedStart.sourceIn, 4); assert.equal(movedStart.sourceOut, 7); const movedEnd = trimFromEvent(0.8, 10, false, 4); assert.equal(movedEnd.sourceIn, 4); assert.equal(movedEnd.sourceOut, 8); });
