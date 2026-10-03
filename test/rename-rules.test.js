"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const rules = require("../src/renderer/rename-rules");

const CONTEXT = {
  name: "DJI_20260924165052_0113_D",
  date: new Date(2026, 9, 3, 14, 5, 9),
  model: "DJI Osmo Action 4 / HG302",
  colorMode: "D-Log M",
  tenBit: false,
  height: 2160,
  fps: 59.94,
  kind: "video",
  index: 7
};

test("renaming keeps the source name until it is switched on", () => {
  assert.equal(rules.buildName({}, CONTEXT), "DJI_20260924165052_0113_D");
  assert.equal(rules.buildName({ enabled: false, prefix: "custom", prefixText: "Trip" }, CONTEXT), "DJI_20260924165052_0113_D");
});

test("the DJI tokens name what the clip needed", () => {
  assert.equal(rules.modelToken("DJI Osmo Action 4 / HG302"), "Action4");
  assert.equal(rules.modelToken("DJI Osmo Pocket 4 Pro"), "Pocket4Pro");
  assert.equal(rules.modelToken(""), "");
  assert.equal(rules.logToken("D-Log M"), "DLogM");
  assert.equal(rules.logToken("D-Log"), "DLog");
  assert.equal(rules.logToken("D-Log 2"), "DLog2");
  assert.equal(rules.logToken("Rec.709"), "");
  assert.equal(rules.resolutionToken(2160), "4K");
  assert.equal(rules.resolutionToken(1080), "1080p");
  assert.equal(rules.fpsToken(59.94), "60p");
  assert.equal(rules.fpsToken(0), "");
});

test("pieces, separators and the running number compose the name", () => {
  const name = rules.buildName({ enabled: true, prefix: "custom", prefixText: "田径", pieces: ["date", "model", "log", "depth", "resolution"], join: "_", dateFormat: "yyyyMMdd" }, CONTEXT);
  assert.equal(name, "田径_20261003_Action4_DLogM_8bit_4K");

  const dashed = rules.buildName({ enabled: true, prefix: "original", pieces: ["date"], join: "-", dateFormat: "yyMMdd" }, CONTEXT);
  assert.equal(dashed, "DJI_20260924165052_0113_D-261003");

  const numbered = rules.buildName({ enabled: true, prefix: "custom", prefixText: "Trip", pieces: ["seq"], join: "_", sequence: true, sequenceStart: 1, sequenceLength: 4 }, { ...CONTEXT, index: 12 });
  assert.equal(numbered, "Trip_0012");
});

test("empty pieces do not leave doubled separators", () => {
  const name = rules.buildName({ enabled: true, prefix: "original", pieces: ["model", "log", "depth"], join: "_" }, { ...CONTEXT, colorMode: "Rec.709", tenBit: undefined });
  assert.equal(name, "DJI_20260924165052_0113_D_Action4");
});

test("prefix and suffix modes match the transfer-tool choices", () => {
  // Asking for the original on both sides is unusual but allowed, and the name
  // says so rather than quietly dropping one of them.
  const withPrefix = rules.buildName({ enabled: true, prefix: "customOriginal", prefixText: "2026", pieces: [], suffix: "originalCustom", suffixText: "final", join: "_" }, CONTEXT);
  assert.equal(withPrefix, "2026_DJI_20260924165052_0113_D_DJI_20260924165052_0113_D_final");
  const one = rules.buildName({ enabled: true, prefix: "customOriginal", prefixText: "2026", pieces: [], suffix: "custom", suffixText: "final", join: "_" }, CONTEXT);
  assert.equal(one, "2026_DJI_20260924165052_0113_D_final");
  const none = rules.buildName({ enabled: true, prefix: "none", pieces: [], suffix: "none", join: "_" }, CONTEXT);
  assert.equal(none, "DJI_20260924165052_0113_D");
});

test("illegal characters never reach a file name", () => {
  const name = rules.buildName({ enabled: true, prefix: "custom", prefixText: "a/b:c*d?e\"f<g>h|i", pieces: [], join: "_" }, CONTEXT);
  assert.equal(name, "abcdefghi");
  assert.equal(rules.sanitize("trailing dot."), "trailing dot");
  assert.equal(rules.buildName({ enabled: true, prefix: "custom", prefixText: "///", pieces: [] }, CONTEXT), "DJI_20260924165052_0113_D");
});

test("the dialog example is the name that lands on disk", () => {
  const model = rules.view({ enabled: true, prefix: "custom", prefixText: "田径", pieces: ["date", "model"], join: "_" }, { ...CONTEXT, extension: ".MP4" });
  assert.equal(model.example, "田径_20261003_Action4.MP4");
  assert.equal(model.isDefault, false);
  assert.equal(rules.view({}, CONTEXT).isDefault, true);
  assert.equal(rules.isDefaultRules({ enabled: true }), false);
});

test("initial state repairs whatever a config file holds", () => {
  const state = rules.initialState({ prefix: "nonsense", pieces: ["date", "nope", "model"], join: "x", dateFormat: "nope", sequenceLength: 99, sequenceStart: -5 });
  assert.equal(state.prefix, "original");
  assert.deepEqual(state.pieces, ["date", "model"]);
  assert.equal(state.join, "_");
  assert.equal(state.dateFormat, "yyyyMMdd");
  assert.equal(state.sequenceLength, 6);
  assert.equal(state.sequenceStart, 1);
});
