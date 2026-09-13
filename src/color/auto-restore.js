"use strict";

// Which technical transform a clip needs to leave log, and whether it needs one
// at all.
//
// This is the single source of truth shared by the editor and by batch export.
// The editor uses it to auto-select restoration when a D-Log clip opens; batch
// export uses it to restore every D-Log clip in a selection without asking. The
// two must agree: a clip that opens in the editor with restoration selected has
// to be restored when it is part of a batch too, or the same file would come out
// looking different depending on how it was exported.
//
// The mapping is by camera model because DJI ships a different Rec.709 transform
// per camera, and applying the wrong one shifts every hue. Order matters:
// "pocket 4 pro" must be tested before "pocket 4", and the bare "action4"
// fallback comes last so unknown models still get a reasonable transform.

const FAMILY_MATCHERS = [
  ["action 6", "action6"],
  ["action 5", "action5pro"],
  ["pocket 4 pro", "pocket4p"],
  ["pocket 4", "pocket4"],
  ["pocket 3", "pocket3"],
  ["nano", "osmo-nano"]
];

// The value the graph builder reads as "leave this clip alone". It is not a
// transform and deliberately matches the editor's existing naming.
const NONE = "none";

function familyForCameraModel(model) {
  const text = String(model || "").toLowerCase();
  for (const [needle, family] of FAMILY_MATCHERS) if (text.includes(needle)) return family;
  return "action4";
}

// Detection reports both "D-Log M" and "D-Log"; both are log and both need the
// same transform. Anything else ("Standard", null, "UNKNOWN") does not.
function isDlogColorMode(mode) {
  return /^D-Log(?:\s|$)/i.test(String(mode || ""));
}

function technicalTransformFor(asset) {
  if (!asset || !isDlogColorMode(asset.djiColorMode)) return NONE;
  return familyForCameraModel(asset.cameraModel);
}

const api = { NONE, FAMILY_MATCHERS, familyForCameraModel, isDlogColorMode, technicalTransformFor };
if (typeof window !== "undefined") window.__autoRestore = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
