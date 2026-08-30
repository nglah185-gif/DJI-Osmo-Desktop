const test = require("node:test");
const assert = require("node:assert/strict");
const { columnsFor, computeWindow } = require("../src/renderer/virtual-grid");

test("columns derive from container width and card width", () => { assert.equal(columnsFor(940, 300, 12), 3); assert.equal(columnsFor(600, 300, 12), 1); assert.equal(columnsFor(0, 300, 12), 1); });
test("window keeps only visible rows plus overscan", () => { const result = computeWindow({ scrollTop: 1200, viewportHeight: 900, itemHeight: 180, gap: 16, columns: 3, total: 1000, overscanRows: 2 }); assert.ok(result.end - result.start < 60, "window is bounded, not all 1000"); assert.ok(result.start > 0, "scrolled window starts past zero"); assert.ok(result.spacerHeight > 0); });
test("window union over stride-scrolled positions covers every item", () => { const total = 85; const seen = new Set(); const stride = 180 + 16; for (let scrollTop = 0; scrollTop <= total * stride; scrollTop += stride) { const result = computeWindow({ scrollTop, viewportHeight: 900, itemHeight: 180, gap: 16, columns: 3, total }); for (let i = result.start; i < result.end; i++) seen.add(i); assert.ok(result.start >= 0 && result.end <= total); } assert.equal(seen.size, total); });
