"use strict";

const { createEffectGraph } = require("./effect-graph");
const { dlogMGraph } = require("./pipeline");

const CREATIVE_LOOKS = new Map([
  ["action4-forest-pro", "action4.creative.forest-pro"],
  ["action4-ice-pro", "action4.creative.ice-pro"],
  ["action4-nature-pro", "action4.creative.nature-pro"]
  , ["action5pro-ju", "action5pro.creative.ju"], ["action5pro-lan", "action5pro.creative.lan"], ["action5pro-mei", "action5pro.creative.mei"], ["action5pro-zhu", "action5pro.creative.zhu"]
]);
function familyForTechnical(value) { return value === "action5pro" ? "Action5Pro" : value === "action6" ? "Action6" : value === "pocket3" ? "Pocket3" : value === "pocket4" ? "Pocket4" : value === "pocket4p" ? "Pocket4Pro" : value === "osmo-nano" ? "OsmoNano" : "Action4"; }

function createEditorEffectGraph(editor = {}) {
  const legacyPreset = editor.colorPreset || "normal";
  const technicalEnabled = ["action4", "action5pro", "action6", "pocket3", "pocket4", "pocket4p", "osmo-nano"].includes(editor.technicalTransform) || legacyPreset === "action4-dlogm";
  const lookPreset = editor.creativeLook || (CREATIVE_LOOKS.has(legacyPreset) ? legacyPreset : "");
  const creative = CREATIVE_LOOKS.get(lookPreset) || null;
  if (technicalEnabled) return dlogMGraph(familyForTechnical(editor.technicalTransform || (legacyPreset === "action4-dlogm" ? "action4" : "action4")), creative);
  return createEffectGraph(creative ? { styleStack: [{ resourceId: creative, parameters: {} }] } : {});
}

module.exports = { CREATIVE_LOOKS, createEditorEffectGraph };
