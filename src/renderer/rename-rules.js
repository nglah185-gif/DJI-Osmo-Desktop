(() => {
  // File naming for exported and backed-up files, in the spirit of a transfer
  // tool's rename dialog: a prefix, a run of metadata pieces, a suffix, one
  // separator and an optional running number -- plus the tokens that matter for
  // DJI footage specifically (which log profile, 8- or 10-bit, the model, the
  // resolution, the frame rate).
  //
  // Pure: the dialog, the export path and the backup copy all call buildName(),
  // so the example in the dialog is the name that lands on disk.

  const JOINS = [
    { value: "_", labelKey: "rename.joinUnderscore" },
    { value: "-", labelKey: "rename.joinDash" },
    { value: " ", labelKey: "rename.joinSpace" },
    { value: "", labelKey: "rename.joinNone" }
  ];

  const PREFIX_MODES = [
    { value: "original", labelKey: "rename.prefixOriginal" },
    { value: "none", labelKey: "rename.prefixNone" },
    { value: "custom", labelKey: "rename.prefixCustom" },
    { value: "originalCustom", labelKey: "rename.prefixOriginalCustom" },
    { value: "customOriginal", labelKey: "rename.prefixCustomOriginal" }
  ];

  const SUFFIX_MODES = [
    { value: "none", labelKey: "rename.suffixNone" },
    { value: "original", labelKey: "rename.suffixOriginal" },
    { value: "custom", labelKey: "rename.suffixCustom" },
    { value: "originalCustom", labelKey: "rename.suffixOriginalCustom" },
    { value: "customOriginal", labelKey: "rename.suffixCustomOriginal" }
  ];

  const DATE_FORMATS = [
    { value: "yyyyMMdd", labelKey: "rename.dateCompact" },
    { value: "yyyy-MM-dd", labelKey: "rename.dateDashed" },
    { value: "yyMMdd", labelKey: "rename.dateShort" },
    { value: "yyyyMMdd-HHmmss", labelKey: "rename.dateWithTime" },
    { value: "HHmmss", labelKey: "rename.timeOnly" }
  ];

  // The pieces a name can be assembled from. "seq" is special: it is rendered
  // from the running number rather than from the file's metadata.
  const PIECES = [
    { value: "date", labelKey: "rename.pieceDate" },
    { value: "model", labelKey: "rename.pieceModel" },
    { value: "log", labelKey: "rename.pieceLog" },
    { value: "depth", labelKey: "rename.pieceDepth" },
    { value: "resolution", labelKey: "rename.pieceResolution" },
    { value: "fps", labelKey: "rename.pieceFps" },
    { value: "kind", labelKey: "rename.pieceKind" },
    { value: "seq", labelKey: "rename.pieceSeq" }
  ];

  const PIECE_VALUES = PIECES.map(piece => piece.value);
  const JOIN_VALUES = JOINS.map(join => join.value);
  const PREFIX_VALUES = PREFIX_MODES.map(mode => mode.value);
  const SUFFIX_VALUES = SUFFIX_MODES.map(mode => mode.value);
  const DATE_VALUES = DATE_FORMATS.map(format => format.value);
  const SEQUENCE_MAX = 99999;

  function initialState(overrides = {}) {
    const raw = overrides && typeof overrides === "object" ? overrides : {};
    const pieces = Array.isArray(raw.pieces) ? raw.pieces.filter(piece => PIECE_VALUES.includes(piece)) : ["date", "model"];
    const start = Number(raw.sequenceStart);
    const length = Number(raw.sequenceLength);
    return {
      enabled: raw.enabled === true,
      prefix: PREFIX_VALUES.includes(raw.prefix) ? raw.prefix : "original",
      prefixText: typeof raw.prefixText === "string" ? raw.prefixText : "",
      pieces,
      join: JOIN_VALUES.includes(raw.join) ? raw.join : "_",
      dateFormat: DATE_VALUES.includes(raw.dateFormat) ? raw.dateFormat : "yyyyMMdd",
      suffix: SUFFIX_VALUES.includes(raw.suffix) ? raw.suffix : "none",
      suffixText: typeof raw.suffixText === "string" ? raw.suffixText : "",
      sequence: raw.sequence === true,
      sequenceStart: Number.isFinite(start) && start >= 0 ? Math.round(start) : 1,
      sequenceLength: Number.isFinite(length) ? Math.min(6, Math.max(1, Math.round(length))) : 3
    };
  }

  function isDefaultRules(rules) {
    const state = initialState(rules);
    return !state.enabled;
  }

  // Windows forbids these outright, and a trailing dot or space is legal in the
  // API but not in the shell.
  function sanitize(value) {
    return String(value == null ? "" : value)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, "");
  }

  function padNumber(value, length) {
    const digits = String(Math.max(0, Math.round(Number(value) || 0)));
    return digits.padStart(Math.max(1, Math.min(6, Number(length) || 1)), "0");
  }

  function formatStamp(date, format, fallback) {
    const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : fallback instanceof Date && !Number.isNaN(fallback.getTime()) ? fallback : null;
    if (!value) return "";
    const pad = number => String(number).padStart(2, "0");
    const yyyy = String(value.getFullYear());
    const yy = yyyy.slice(2);
    const mm = pad(value.getMonth() + 1);
    const dd = pad(value.getDate());
    const hh = pad(value.getHours());
    const mi = pad(value.getMinutes());
    const ss = pad(value.getSeconds());
    switch (format) {
      case "yyyy-MM-dd": return yyyy + "-" + mm + "-" + dd;
      case "yyMMdd": return yy + mm + dd;
      case "yyyyMMdd-HHmmss": return yyyy + mm + dd + "-" + hh + mi + ss;
      case "HHmmss": return hh + mi + ss;
      default: return yyyy + mm + dd;
    }
  }

  // The device name as DJI writes it in a file name: "DJI Osmo Action 4" ->
  // "Action4", "DJI Osmo Pocket 4 Pro" -> "Pocket4Pro".
  function modelToken(cameraModel) {
    const text = String(cameraModel || "");
    if (!text) return "";
    return sanitize(text.replace(/^DJI\s+/i, "").replace(/^Osmo\s+/i, "").replace(/\s*\/.*$/, "").replace(/\s+/g, ""));
  }

  function logToken(colorMode) {
    const text = String(colorMode || "").replace(/[\s_-]+/g, "").toLowerCase();
    if (!text.startsWith("dlog")) return "";
    return text === "dlogm" ? "DLogM" : text === "dlog2" ? "DLog2" : "DLog";
  }

  function resolutionToken(height) {
    const value = Number(height) || 0;
    if (!value) return "";
    if (value >= 2160) return "4K";
    if (value >= 1440) return "1440p";
    if (value >= 1080) return "1080p";
    if (value >= 720) return "720p";
    return value + "p";
  }

  function fpsToken(fps) {
    const value = Math.round(Number(fps) || 0);
    return value > 0 ? value + "p" : "";
  }

  function pieceValue(piece, context, rules) {
    const source = context && typeof context === "object" ? context : {};
    switch (piece) {
      case "date": return formatStamp(source.date, rules.dateFormat, source.fallbackDate);
      case "model": return modelToken(source.model);
      case "log": return logToken(source.colorMode);
      case "depth": return source.tenBit === true ? "10bit" : source.tenBit === false ? "8bit" : "";
      case "resolution": return resolutionToken(source.height);
      case "fps": return fpsToken(source.fps);
      case "kind": return source.kind === "photo" ? "photo" : source.kind === "video" ? "video" : "";
      case "seq": return rules.sequence ? padNumber(source.index, rules.sequenceLength) : "";
      default: return "";
    }
  }

  function withText(mode, text, original) {
    const custom = sanitize(text);
    switch (mode) {
      case "none": return [];
      case "custom": return custom ? [custom] : [];
      case "originalCustom": return custom ? [original, custom] : [original];
      case "customOriginal": return custom ? [custom, original] : [original];
      default: return [original];
    }
  }

  // rules + context -> file name without an extension. Empty pieces are dropped
  // rather than left as doubled separators, so "Action4_20261003" never becomes
  // "Action4__20261003".
  function buildName(rules, context) {
    const state = initialState(rules);
    const source = context && typeof context === "object" ? context : {};
    const original = sanitize(source.name) || "clip";
    if (!state.enabled) return original;
    const head = withText(state.prefix, state.prefixText, original);
    const middle = state.pieces.map(piece => sanitize(pieceValue(piece, source, state))).filter(Boolean);
    const tail = withText(state.suffix, state.suffixText, original);
    const parts = [...head, ...middle, ...tail].filter(Boolean);
    return parts.join(state.join) || original;
  }

  function view(rules, context) {
    const state = initialState(rules);
    return {
      ...state,
      joins: JOINS,
      prefixModes: PREFIX_MODES,
      suffixModes: SUFFIX_MODES,
      dateFormats: DATE_FORMATS,
      pieces: PIECES,
      pieceValues: PIECE_VALUES,
      example: buildName(state, context) + (context && context.extension ? context.extension : ""),
      enabled: state.enabled,
      isDefault: isDefaultRules(state)
    };
  }

  const api = { JOINS, PREFIX_MODES, SUFFIX_MODES, DATE_FORMATS, PIECES, SEQUENCE_MAX, initialState, isDefaultRules, sanitize, padNumber, formatStamp, modelToken, logToken, resolutionToken, fpsToken, buildName, view };
  if (typeof window !== "undefined") window.__renameRules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
