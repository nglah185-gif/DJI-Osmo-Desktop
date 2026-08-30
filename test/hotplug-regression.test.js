const test = require("node:test");
const assert = require("node:assert/strict");
const { HotplugRegressionHarness, evaluate } = require("../src/device-adapter/hotplug-regression");

test("hotplug state machine requires two real insertions and removals", async () => {
  const present = [{ id: "volume:F:\\\\", path: "F:\\\\", label: "SD_Card", cameraModel: "DJI Osmo Action 4 / HG302", status: "POSSIBLE_DJI_STORAGE", score: 100, evidence: { dcim: true, mp4: true, lrf: true, aac: true } }];
  const result = await new HotplugRegressionHarness({ provider: { discover: async () => [] } }).runSequence([[], present, [], present, []]);
  assert.equal(result.pass, true); assert.deepEqual(result.transitions, ["ABSENT", "PRESENT", "ABSENT", "PRESENT", "ABSENT"]); assert.equal(result.events[1].device.cameraModel, "DJI Osmo Action 4 / HG302");
});

test("hotplug state machine rejects a single insertion", () => { assert.equal(evaluate([{ state: "ABSENT" }, { state: "PRESENT" }, { state: "ABSENT" }]).pass, false); });

test("hotplug evaluator accepts a connected baseline before two cycles", () => {
  const result = evaluate([{ state: "PRESENT" }, { state: "ABSENT" }, { state: "PRESENT" }, { state: "ABSENT" }, { state: "PRESENT" }, { state: "ABSENT" }]);
  assert.equal(result.pass, true);
});

test("real hotplug runner is opt-in and does not invent a device", async () => { const harness = new HotplugRegressionHarness({ provider: { discover: async () => [] }, intervalMs: 1 }); const result = await harness.runReal({ cycles: 1, timeoutMs: 5 }); assert.equal(result.pass, false); assert.equal(result.events[0].state, "ABSENT"); });
