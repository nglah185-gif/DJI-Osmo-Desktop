function ratioToSeconds(ratio, duration) { const value = Number(ratio); if (!Number.isFinite(value)) return 0; if (!(duration > 0)) return 0; return Math.max(0, Math.min(duration, value * duration)); }
function secondsToRatio(current, duration) { if (!(duration > 0)) return 0; return Number(current) <= 0 ? 0 : Math.max(0, Math.min(1, Number(current) / duration)); }
function timeToDisplay(seconds) { const safe = Math.max(0, Number(seconds) || 0); const minutes = Math.floor(safe / 60); const secs = safe - minutes * 60; return String(minutes).padStart(2, "0") + ":" + secs.toFixed(3).padStart(6, "0"); }
module.exports = { ratioToSeconds, secondsToRatio, timeToDisplay };
