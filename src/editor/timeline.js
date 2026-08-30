const MICROSECONDS = 1000000;
function secondsToUs(seconds) { return Math.max(0, Math.round(Number(seconds || 0) * MICROSECONDS)); }
function usToSeconds(us) { return Number(us || 0) / MICROSECONDS; }
function createTimelineClip(asset, overrides = {}) {
  const durationUs = secondsToUs(asset.original.probe.duration);
  const sourceInUs = Math.min(durationUs, Math.max(0, overrides.sourceInUs ?? 0));
  const sourceOutUs = Math.max(sourceInUs + 1, Math.min(durationUs, overrides.sourceOutUs ?? durationUs));
  const playbackRate = [0.5, 1, 2].includes(Number(overrides.playbackRate)) ? Number(overrides.playbackRate) : 1;
  return Object.freeze({ assetId: asset.id, sourceInUs, sourceOutUs, timelineInUs: 0, playbackRate, volume: Math.max(0, Math.min(1, Number(overrides.volume ?? 1))), muted: Boolean(overrides.muted), displayTransform: Object.freeze({ crop: { left: 0, top: 0, right: 0, bottom: 0 }, rotation: 0, flipHorizontal: false, flipVertical: false, ...(overrides.displayTransform || {}) }), effectGraphRef: overrides.effectGraphRef || null });
}
function clipDurationUs(clip) { return Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.playbackRate); }
function updateClip(clip, changes = {}) { return createTimelineClip({ id: clip.assetId, original: { probe: { duration: usToSeconds(clip.sourceOutUs) } } }, { ...clip, ...changes, displayTransform: { ...clip.displayTransform, ...(changes.displayTransform || {}) } }); }
module.exports = { MICROSECONDS, secondsToUs, usToSeconds, createTimelineClip, clipDurationUs, updateClip };
