const { createColorProfile } = require("./color-profile");
const { createEffectGraph } = require("./effect-graph");

const CAMERA_PROFILES = Object.freeze({
  Action4: { cameraModel: "DJI Osmo Action 4 / HG302", technicalTransformId: "action4.dlogm.rec709.website-cube", technicalTransformSha256: "B18162854AB47702068410C33AFA98A8CB6EEF159FC5A04CE0E65FAD0FD8947E", validationStatus: "PRIMARY_REAL_DEVICE" },
  Action5Pro: { cameraModel: "DJI Osmo Action 5 Pro", technicalTransformId: "action5pro.dlogm.rec709.website-cube", technicalTransformSha256: "B18162854AB47702068410C33AFA98A8CB6EEF159FC5A04CE0E65FAD0FD8947E", validationStatus: "PROFILE_ONLY" },
  Action6: { cameraModel: "DJI Osmo Action 6", technicalTransformId: "action6.dlogm.rec709.website-cube", technicalTransformSha256: "1972EB9B05699BA19D4AAA67AAA5FB00B46935C60BA9219183289F79E044CBB2", validationStatus: "PROFILE_ONLY" }
  , Pocket3: { cameraModel: "DJI Osmo Pocket 3", technicalTransformId: "pocket3.dlogm.rec709.extra-cube", technicalTransformSha256: "B18162854AB47702068410C33AFA98A8CB6EEF159FC5A04CE0E65FAD0FD8947E", validationStatus: "PROFILE_ONLY" }
  , Pocket4: { cameraModel: "DJI Osmo Pocket 4", technicalTransformId: "pocket4.dlog.rec709.extra-cube", technicalTransformSha256: "CA8BC7D3BF382512ED9501137C8B88D1829AE9B22A84965D7D2E1339F615DE72", validationStatus: "PROFILE_ONLY" }
  , Pocket4Pro: { cameraModel: "DJI Osmo Pocket 4 Pro", technicalTransformId: "pocket4p.dlog.rec709.extra-cube", technicalTransformSha256: "CA8BC7D3BF382512ED9501137C8B88D1829AE9B22A84965D7D2E1339F615DE72", validationStatus: "PROFILE_ONLY" }
  , OsmoNano: { cameraModel: "DJI Osmo Nano", technicalTransformId: "osmo-nano.dlogm.rec709.extra-cube", technicalTransformSha256: "B18162854AB47702068410C33AFA98A8CB6EEF159FC5A04CE0E65FAD0FD8947E", validationStatus: "PROFILE_ONLY" }
});
function dlogMProfile(cameraFamily, detectionConfidence = "USER_SELECTED") {
  const mapping = CAMERA_PROFILES[cameraFamily]; if (!mapping) throw new Error("Unsupported camera profile: " + cameraFamily);
  return createColorProfile({ ...mapping, cameraFamily, colorMode: "DLOG_M", detectionConfidence, inputColorSpace: "DJI D-Log M", transferFunction: "DJI D-Log M", outputColorSpace: "Rec.709", source: "DJI_OFFICIAL_WEBSITE" });
}
function action4DlogMProfile(detectionConfidence = "USER_SELECTED") { return dlogMProfile("Action4", detectionConfidence); }
function dlogMGraph(cameraFamily = "Action4", creativeLookId = null) { return createEffectGraph({ colorTransform: { kind: "technical-color", enabled: true, colorProfile: dlogMProfile(cameraFamily), intensity: 1 }, styleStack: creativeLookId ? [{ resourceId: creativeLookId, parameters: {} }] : [] }); }
function action4DlogGraph(creativeLookId = null) { return dlogMGraph("Action4", creativeLookId); }
module.exports = { CAMERA_PROFILES, dlogMProfile, action4DlogMProfile, dlogMGraph, action4DlogGraph };
