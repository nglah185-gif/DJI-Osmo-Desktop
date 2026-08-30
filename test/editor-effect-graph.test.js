"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createEditorEffectGraph } = require("../src/color/editor-effect-graph");

test("normal editor graph has no technical or creative transform", () => {
  const graph = createEditorEffectGraph({ technicalTransform: "none", creativeLook: "" });
  assert.equal(graph.colorTransform.enabled, false);
  assert.deepEqual(graph.styleStack, []);
});

test("D-Log M restoration can be enabled without a creative look", () => {
  const graph = createEditorEffectGraph({ technicalTransform: "action4", creativeLook: "" });
  assert.equal(graph.colorTransform.enabled, true);
  assert.equal(graph.colorTransform.colorProfile.colorMode, "DLOG_M");
  assert.deepEqual(graph.styleStack, []);
});

test("creative look does not implicitly apply a D-Log transform", () => {
  const graph = createEditorEffectGraph({ technicalTransform: "none", creativeLook: "action4-forest-pro" });
  assert.equal(graph.colorTransform.enabled, false);
  assert.equal(graph.styleStack[0].resourceId, "action4.creative.forest-pro");
});

test("D-Log M restoration and creative look compose in pipeline order", () => {
  const graph = createEditorEffectGraph({ technicalTransform: "action4", creativeLook: "action4-ice-pro" });
  assert.equal(graph.colorTransform.enabled, true);
  assert.equal(graph.styleStack[0].resourceId, "action4.creative.ice-pro");
});
