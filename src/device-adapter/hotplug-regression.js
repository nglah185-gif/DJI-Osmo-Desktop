const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class HotplugRegressionHarness {
  constructor({ provider, pipeline = null, intervalMs = 3000, now = () => new Date().toISOString() }) { this.provider = provider; this.pipeline = pipeline; this.intervalMs = intervalMs; this.now = now; }
  classify(devices) { const device = devices.find(item => item.status === "POSSIBLE_DJI_STORAGE"); return device ? { state: "PRESENT", device } : { state: "ABSENT", device: null }; }
  async runSequence(sequence) {
    const events = [];
    for (const devices of sequence) { const classified = this.classify(devices); events.push({ at: this.now(), state: classified.state, device: classified.device ? summarize(classified.device) : null }); }
    return evaluate(events);
  }
  async runReal({ cycles = 2, timeoutMs = 300000, onEvent = () => {} } = {}) {
    const started = Date.now(); const events = []; let lastState = null; let presentCount = 0; let absentCount = 0;
    while (Date.now() - started < timeoutMs) {
      const devices = await this.provider.discover(); const classified = this.classify(devices);
      if (classified.state !== lastState) {
        const event = { at: this.now(), state: classified.state, device: classified.device ? summarize(classified.device) : null };
        events.push(event); lastState = classified.state; onEvent(event);
        if (classified.state === "PRESENT") { presentCount++; if (this.pipeline) await this.pipeline.scan(); } else absentCount++;
        if (presentCount >= cycles && absentCount >= cycles + 1) return evaluate(events);
      }
      await sleep(this.intervalMs);
    }
    return { pass: false, reason: "Timed out waiting for physical hotplug transitions", events, required: { absent: cycles + 1, present: cycles } };
  }
}
function summarize(device) { return { id: device.id, path: device.path, label: device.label, cameraModel: device.cameraModel, status: device.status, score: device.score, evidence: device.evidence }; }
function evaluate(events) {
  const states = events.map(event => event.state);
  const alternating = states.length >= 3 && states.every((state, index) => index === 0 || state !== states[index - 1]);
  const presentCount = states.filter(state => state === "PRESENT").length;
  const absentCount = states.filter(state => state === "ABSENT").length;
  // The operator may start the runner while the camera is already mounted.
  // In that case the initial PRESENT is a baseline, not the first insertion.
  const startsAbsent = states[0] === "ABSENT" && presentCount >= 2 && absentCount >= 3;
  const startsPresent = states[0] === "PRESENT" && presentCount >= 3 && absentCount >= 3 && states.at(-1) === "ABSENT";
  const pass = alternating && (startsAbsent || startsPresent);
  return { pass, events, transitions: states, reason: pass ? "Two insertions and two removals observed" : "Expected two complete insert/remove cycles ending ABSENT" };
}
module.exports = { HotplugRegressionHarness, evaluate };
