(() => {
  // Pure state for the "video specification" controls in the batch export
  // dialog: resolution, frame rate, rate control and 10-bit encoding. The
  // engine owns the authoritative validation (src/renderers/video-spec.js);
  // this module only keeps the dialog's choices coherent and emits the shape
  // the export IPC expects, so the two cannot drift.
  //
  // Every option defaults to "source" / quality / 8-bit, which is exactly what
  // the single-item export does today. A batch that changes nothing behaves
  // like the old build, including the passthrough copy path.

  const RESOLUTIONS = [
    { value: "source", labelKey: "videoExport.resolutionSource" },
    { value: "2160", labelKey: "videoExport.resolution2160" },
    { value: "1440", labelKey: "videoExport.resolution1440" },
    { value: "1080", labelKey: "videoExport.resolution1080" },
    { value: "720", labelKey: "videoExport.resolution720" }
  ];
  const FRAME_RATES = [
    { value: "source", labelKey: "videoExport.fpsSource" },
    { value: "60", labelKey: "videoExport.fps60" },
    { value: "50", labelKey: "videoExport.fps50" },
    { value: "30", labelKey: "videoExport.fps30" },
    { value: "25", labelKey: "videoExport.fps25" },
    { value: "24", labelKey: "videoExport.fps24" }
  ];
  const RATE_MODES = [
    { value: "quality", labelKey: "videoExport.rateQuality" },
    { value: "bitrate", labelKey: "videoExport.rateBitrate" }
  ];
  const CODECS = [
    { value: "auto", labelKey: "videoExport.codecAuto" },
    { value: "h264", labelKey: "videoExport.codecH264" },
    { value: "hevc", labelKey: "videoExport.codecHevc" }
  ];
  const MIN_BITRATE_MBPS = 1;
  const MAX_BITRATE_MBPS = 500;
  const DEFAULT_BITRATE_MBPS = 40;

  const RESOLUTION_VALUES = RESOLUTIONS.map(entry => entry.value);
  const FPS_VALUES = FRAME_RATES.map(entry => entry.value);
  const RATE_VALUES = RATE_MODES.map(entry => entry.value);
  const CODEC_VALUES = CODECS.map(entry => entry.value);

  function initialState(overrides = {}) {
    const raw = overrides && typeof overrides === "object" ? overrides : {};
    const resolution = RESOLUTION_VALUES.includes(String(raw.resolution)) ? String(raw.resolution) : "source";
    const fps = FPS_VALUES.includes(String(raw.fps)) ? String(raw.fps) : "source";
    const rate = RATE_VALUES.includes(String(raw.rate)) ? String(raw.rate) : "quality";
    const codec = CODEC_VALUES.includes(String(raw.codec)) ? String(raw.codec) : "auto";
    const bitrate = Number(raw.bitrateMbps);
    return {
      resolution,
      fps,
      rate,
      codec,
      bitrateMbps: Number.isFinite(bitrate) && bitrate >= MIN_BITRATE_MBPS && bitrate <= MAX_BITRATE_MBPS ? Math.round(bitrate * 10) / 10 : DEFAULT_BITRATE_MBPS,
      // H.264 cannot carry the 10-bit request; the checkbox is disabled in that
      // state and the engine would resolve HEVC anyway.
      tenBit: raw.tenBit === true && codec !== "h264"
    };
  }

  function setResolution(state, value) {
    const next = RESOLUTION_VALUES.includes(String(value)) ? String(value) : "source";
    return next === state.resolution ? state : { ...state, resolution: next };
  }
  function setFps(state, value) {
    const next = FPS_VALUES.includes(String(value)) ? String(value) : "source";
    return next === state.fps ? state : { ...state, fps: next };
  }
  function setRate(state, value) {
    const next = RATE_VALUES.includes(String(value)) ? String(value) : "quality";
    return next === state.rate ? state : { ...state, rate: next };
  }
  function setCodec(state, value) {
    const next = CODEC_VALUES.includes(String(value)) ? String(value) : "auto";
    if (next === state.codec) return state;
    // Picking H.264 while 10-bit is ticked would leave an impossible pair; the
    // checkbox clears instead, so the dialog never shows a state the engine has
    // to reinterpret.
    return { ...state, codec: next, tenBit: next === "h264" ? false : state.tenBit };
  }
  function setBitrate(state, value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return state;
    const clamped = Math.max(MIN_BITRATE_MBPS, Math.min(MAX_BITRATE_MBPS, Math.round(number * 10) / 10));
    return clamped === state.bitrateMbps ? state : { ...state, bitrateMbps: clamped };
  }
  function setTenBit(state, value) {
    const next = value === true;
    if (next === state.tenBit) return state;
    // 10-bit implies HEVC. If the codec selector says H.264 the selector moves
    // with the request rather than the request being dropped.
    return { ...state, tenBit: next, codec: next && state.codec === "h264" ? "hevc" : state.codec };
  }

  // One flag drives both the summary line and the "will re-encode" warning:
  // any option other than the source defaults changes every clip's output.
  function isDefaultSpec(state) {
    return state.resolution === "source" && state.fps === "source" && state.rate === "quality" && state.codec === "auto" && state.tenBit === false;
  }

  function payload(state) {
    return {
      resolution: state.resolution,
      fps: state.fps,
      rate: state.rate,
      codec: state.codec,
      bitrateMbps: state.bitrateMbps,
      tenBit: state.tenBit
    };
  }

  function view(state) {
    return {
      resolution: state.resolution,
      fps: state.fps,
      rate: state.rate,
      codec: state.codec,
      bitrateMbps: state.bitrateMbps,
      bitrateVisible: state.rate === "bitrate",
      tenBit: state.tenBit,
      // H.264 has no 10-bit profile on this pipeline, so the option is off
      // rather than silently ignored.
      tenBitDisabled: state.codec === "h264",
      resolutions: RESOLUTIONS,
      frameRates: FRAME_RATES,
      rateModes: RATE_MODES,
      codecs: CODECS,
      isDefault: isDefaultSpec(state),
      summaryKey: isDefaultSpec(state) ? "videoExport.summarySource" : "videoExport.summaryCustom"
    };
  }

  const api = { RESOLUTIONS, FRAME_RATES, RATE_MODES, CODECS, MIN_BITRATE_MBPS, MAX_BITRATE_MBPS, DEFAULT_BITRATE_MBPS, initialState, setResolution, setFps, setRate, setCodec, setBitrate, setTenBit, isDefaultSpec, payload, view };
  if (typeof window !== "undefined") window.__videoExportOptions = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
