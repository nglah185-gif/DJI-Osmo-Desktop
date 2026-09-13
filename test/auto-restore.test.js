"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const restore = require("../src/color/auto-restore");

test("each camera model maps to its own family", () => {
  assert.equal(restore.familyForCameraModel("DJI Osmo Action 4 / HG302"), "action4");
  assert.equal(restore.familyForCameraModel("DJI Osmo Action 5 Pro"), "action5pro");
  assert.equal(restore.familyForCameraModel("DJI Osmo Action 6"), "action6");
  assert.equal(restore.familyForCameraModel("DJI Osmo Pocket 3"), "pocket3");
  assert.equal(restore.familyForCameraModel("DJI Osmo Pocket 4"), "pocket4");
  assert.equal(restore.familyForCameraModel("DJI Osmo Pocket 4 Pro"), "pocket4p");
  assert.equal(restore.familyForCameraModel("DJI Osmo Nano"), "osmo-nano");
});

test("the pro model is not swallowed by its shorter sibling", () => {
  // "pocket 4 pro" contains "pocket 4", so a wrong order would apply the plain
  // Pocket 4 transform to Pro footage and shift every hue.
  assert.equal(restore.familyForCameraModel("Pocket 4 Pro"), "pocket4p");
  assert.equal(restore.familyForCameraModel("Pocket 4"), "pocket4");
});

test("an unknown model still gets a usable transform instead of none", () => {
  assert.equal(restore.familyForCameraModel("Some Camera"), "action4");
  assert.equal(restore.familyForCameraModel(null), "action4");
});

test("both D-Log spellings count as log; Standard does not", () => {
  assert.equal(restore.isDlogColorMode("D-Log M"), true);
  assert.equal(restore.isDlogColorMode("D-Log"), true);
  assert.equal(restore.isDlogColorMode("d-log m"), true);
  assert.equal(restore.isDlogColorMode("Standard"), false);
  assert.equal(restore.isDlogColorMode("UNKNOWN"), false);
  assert.equal(restore.isDlogColorMode(null), false);
});

test("a D-Log clip resolves to its camera transform, everything else to none", () => {
  assert.equal(restore.technicalTransformFor({ cameraModel: "DJI Osmo Action 4 / HG302", djiColorMode: "D-Log M" }), "action4");
  assert.equal(restore.technicalTransformFor({ cameraModel: "DJI Osmo Pocket 3", djiColorMode: "D-Log" }), "pocket3");
  assert.equal(restore.technicalTransformFor({ cameraModel: "DJI Osmo Action 4", djiColorMode: "Standard" }), "none");
  assert.equal(restore.technicalTransformFor(null), "none");
});

test("the none sentinel is the string the graph builder already understands", () => {
  assert.equal(restore.NONE, "none");
});
