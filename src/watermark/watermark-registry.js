"use strict";

const path = require("node:path"); const crypto = require("node:crypto"); const fs = require("node:fs");
const { InkBoxCache } = require("./watermark-ink-box");

// Every badge DJI ships, mapped to the device whose footage it belongs on.
//
// The device names are read off the artwork itself rather than guessed from the
// token: o307/o507 are the Osmo Mobile 7 and 7P, o308/o508 the 8 and 8P, on1 is
// the Osmo Nano and 520 is the seasonal "Love is Action" mark. Order matters --
// a longer token must be tested before the shorter one it starts with, so
// oa5pro wins over oa5p and mobile8p over mobile8.
const WATERMARK_DEVICES = [
  { token: "oa6", family: "Action6", name: "DJI Osmo Action 6" },
  { token: "oa5pro", family: "Action5Pro", name: "DJI Osmo Action 5 Pro" },
  { token: "oa5p", family: "Action5Pro", name: "DJI Osmo Action 5 Pro" },
  { token: "oa5", family: "Action5", name: "DJI Osmo Action 5" },
  { token: "oa4", family: "Action4", name: "DJI Osmo Action 4" },
  { token: "oa3", family: "Action3", name: "DJI Osmo Action 3" },
  { token: "op4p", family: "Pocket4Pro", name: "DJI Osmo Pocket 4 Pro" },
  { token: "op4", family: "Pocket4", name: "DJI Osmo Pocket 4" },
  { token: "op3", family: "Pocket3", name: "DJI Osmo Pocket 3" },
  { token: "on1", family: "OsmoNano", name: "DJI Osmo Nano" },
  { token: "o360", family: "Osmo360", name: "DJI Osmo 360" },
  { token: "o508", family: "Mobile8Pro", name: "DJI Osmo Mobile 8P" },
  { token: "o507", family: "Mobile7Pro", name: "DJI Osmo Mobile 7P" },
  { token: "o308", family: "Mobile8", name: "DJI Osmo Mobile 8" },
  { token: "o307", family: "Mobile7", name: "DJI Osmo Mobile 7" },
  { token: "mobile8p", family: "Mobile8Pro", name: "DJI Osmo Mobile 8P" },
  { token: "mobile7p", family: "Mobile7Pro", name: "DJI Osmo Mobile 7P" },
  { token: "mobile8", family: "Mobile8", name: "DJI Osmo Mobile 8" },
  { token: "mobile7", family: "Mobile7", name: "DJI Osmo Mobile 7" },
  { token: "mobile6", family: "Mobile6", name: "DJI Osmo Mobile 6" },
  { token: "520", family: "LoveIsAction", name: "Osmo \u00b7 Love is Action" }
].sort((a, b) => b.token.length - a.token.length);

// The style suffix. A leading number is the base design (1 logo, 2 wordmark,
// 3 camera glyph); anything after it names the paired device the badge shows
// alongside the camera, e.g. "2_coros" is style 2 with a COROS mark.
function parseVariant(suffix) {
  const parts = String(suffix || "").split("_").filter(Boolean);
  let index = null;
  if (parts.length && /^\d+$/.test(parts[0])) index = Number(parts.shift());
  const rest = parts.join("_");
  if (!rest) return { kind: "standard", index: index || 1 };
  if (rest === "borderless") return { kind: "borderless", style: index };
  const frame = /^filter_(\d+)$/.exec(rest);
  if (frame) return { kind: "frame", index: Number(frame[1]), style: index };
  return { kind: "partner", brand: rest, index };
}

// `new_year_oa4_2` carries the season before the device token, so it is split
// off first rather than treated as another style suffix.
function parseFile(fileName) {
  const withoutPrefix = fileName.replace(/^pic_watermark_/i, "").replace(/\.png$/i, "");
  let token = withoutPrefix;
  let seasonal = null;
  const season = /^new_year_(.+?)_(\d+)$/.exec(withoutPrefix);
  if (season) { token = season[1]; seasonal = Number(season[2]); }
  const device = WATERMARK_DEVICES.find(entry => token === entry.token || token.startsWith(entry.token + "_"));
  if (!device) return null;
  const suffix = token === device.token ? "" : token.slice(device.token.length + 1);
  const variant = seasonal === null ? parseVariant(suffix) : { kind: "seasonal", index: seasonal, style: parseVariant(suffix).index };
  return { device, variant };
}

// The existing default badge id must not move: it is written into saved state,
// the docs and the unattended script.
//
// A style number that is not 1 is always carried in the id, because the same
// device ships two numbered series (o360_filter_1 and o360_2_filter_1 are
// different artwork and would otherwise collide).
function styleSegment(variant) {
  const style = Number(variant && variant.style);
  return Number.isFinite(style) && style > 1 ? "." + style : "";
}
function idFor(device, variant) {
  const base = device.family.toLowerCase() + ".official." + device.token;
  if (variant.kind === "standard") return variant.index === 1 ? base : base + "." + variant.index;
  if (variant.kind === "borderless") return base + styleSegment(variant) + ".borderless";
  if (variant.kind === "frame") return base + styleSegment(variant) + ".frame" + variant.index;
  if (variant.kind === "seasonal") return base + styleSegment(variant) + ".newyear" + (variant.index === 1 ? "" : variant.index);
  return base + (variant.index ? "." + variant.index : "") + "." + variant.brand.replace(/_/g, "-");
}

class WatermarkRegistry {
  // inkBoxCache measures each badge's visible glyph box from its own alpha
  // channel. Padding differs per asset, so a shared hardcoded box produces an
  // out-of-bounds crop and fails the whole ffmpeg graph for most styles.
  constructor({ inkBoxCache = null } = {}) { this.entries = new Map(); this.inkBoxCache = inkBoxCache; }
  register(entry) { if (!entry.id || !entry.path) throw new Error("Watermark id and path are required"); const sha256 = crypto.createHash("sha256").update(fs.readFileSync(entry.path)).digest("hex").toUpperCase(); this.entries.set(entry.id, Object.freeze({ kind: "image", source: "DJI_OFFICIAL_ASSET", ...entry, sha256 })); return this.entries.get(entry.id); }
  get(id) { return this.entries.get(id) || null; }
  list() { return [...this.entries.values()]; }
  forCameraModel(cameraModel) { const family = familyForCameraModel(cameraModel); return this.list().filter(entry => entry.family === family).sort(compareVariants); }
  // The badges for a set of camera models, de-duplicated and kept in device
  // order, so a batch of mixed footage offers each badge once.
  forCameraModels(models) {
    const wanted = new Set((Array.isArray(models) ? models : []).map(familyForCameraModel).filter(Boolean));
    return this.list().filter(entry => wanted.has(entry.family)).sort(compareVariants);
  }
  // Every badge grouped by device, for the picker's "all devices" scope. The
  // groups follow the hardware line rather than the file names, so the plain
  // action and pocket badges come before novelty ones.
  catalog() {
    const groups = [];
    const byFamily = new Map();
    for (const entry of this.list()) {
      if (!byFamily.has(entry.family)) { const group = { family: entry.family, name: entry.familyName, entries: [] }; byFamily.set(entry.family, group); groups.push(group); }
      byFamily.get(entry.family).entries.push(entry);
    }
    for (const group of groups) group.entries.sort(compareVariants);
    groups.sort((a, b) => familyRank(a.family) - familyRank(b.family));
    return groups;
  }
  // Returns the cached ink box if it has already been measured, else null. Kept
  // synchronous so graph building never blocks; callers prime the cache first.
  inkBoxFor(id) { const entry = this.get(id); return entry && this.inkBoxCache ? this.inkBoxCache.get(entry.sha256) : null; }
  // Measure on demand and remember the result, keyed by content hash so a
  // replaced asset is re-measured automatically.
  async ensureInkBox(id) {
    const entry = this.get(id);
    if (!entry || !this.inkBoxCache) return null;
    return this.inkBoxCache.resolve(entry);
  }
}

// Standard designs first, then the cropped-edge version, the decorative frames,
// paired-device marks and finally the seasonal ones.
const VARIANT_ORDER = { standard: 0, borderless: 1, frame: 2, partner: 3, seasonal: 4 };
function compareVariants(a, b) {
  const order = (VARIANT_ORDER[a.variant.kind] ?? 9) - (VARIANT_ORDER[b.variant.kind] ?? 9);
  if (order) return order;
  return (a.variant.index || 0) - (b.variant.index || 0) || String(a.variant.brand || "").localeCompare(String(b.variant.brand || ""));
}

// The device groups follow the hardware line the way it reads on a shelf:
// current cameras first, the novelty badge last.
const FAMILY_ORDER = ["Action6", "Action5Pro", "Action5", "Action4", "Action3", "Pocket4Pro", "Pocket4", "Pocket3", "OsmoNano", "Osmo360", "Mobile8Pro", "Mobile8", "Mobile7Pro", "Mobile7", "Mobile6", "LoveIsAction"];
function familyRank(family) { const index = FAMILY_ORDER.indexOf(family); return index === -1 ? FAMILY_ORDER.length : index; }

// Which device a camera model from the media pipeline belongs to. The camera
// families are matched by name because that is what the metadata carries; the
// gimbals and the 360 are only reachable through the picker's full list.
function familyForCameraModel(cameraModel) {
  const value = String(cameraModel || "").toLowerCase().replace(/[\s_-]+/g, "");
  if (/action6|oa6/.test(value)) return "Action6";
  if (/action5|oa5pro|oa5p/.test(value)) return "Action5Pro";
  if (/action4|oa4|hg302/.test(value)) return "Action4";
  if (/action3|oa3/.test(value)) return "Action3";
  if (/pocket4pro|op4p/.test(value)) return "Pocket4Pro";
  if (/pocket4|op4/.test(value)) return "Pocket4";
  if (/pocket3|op3/.test(value)) return "Pocket3";
  if (/nano|on1/.test(value)) return "OsmoNano";
  if (/osmo360|o360/.test(value)) return "Osmo360";
  if (/mobile8p|o508/.test(value)) return "Mobile8Pro";
  if (/mobile7p|o507/.test(value)) return "Mobile7Pro";
  if (/mobile8|o308/.test(value)) return "Mobile8";
  if (/mobile7|o307/.test(value)) return "Mobile7";
  if (/mobile6/.test(value)) return "Mobile6";
  return null;
}

function createWatermarkRegistry(root, { cacheRoot = null, inkBoxCache = null } = {}) {
  // Measuring every shipped badge up front would spawn one ffmpeg per asset at
  // startup, so measurement stays lazy and is cached by hash on disk.
  const registry = new WatermarkRegistry({ inkBoxCache: inkBoxCache || new InkBoxCache({ cacheRoot }) });
  const watermarkRoot = path.join(root, "watermark");
  const files = fs.existsSync(watermarkRoot) ? fs.readdirSync(watermarkRoot).filter(file => /^pic_watermark_.*\.png$/i.test(file)).sort() : [];
  for (const file of files) {
    const parsed = parseFile(file);
    if (!parsed) continue;
    registry.register({
      id: idFor(parsed.device, parsed.variant),
      family: parsed.device.family,
      familyName: parsed.device.name,
      token: parsed.device.token,
      variant: parsed.variant,
      sourceFile: file,
      path: path.join(watermarkRoot, file)
    });
  }
  return registry;
}

// A readable fallback label for callers with no translator (the batch script's
// log, tests). The UI builds its own label from the variant so it can translate.
function describe(entry) {
  const variant = entry.variant || {};
  if (variant.kind === "borderless") return entry.familyName + " borderless";
  if (variant.kind === "frame") return entry.familyName + " frame " + variant.index;
  if (variant.kind === "seasonal") return entry.familyName + " new year " + (variant.index || "");
  if (variant.kind === "partner") return entry.familyName + " " + String(variant.brand || "").replace(/_/g, " ");
  return entry.familyName + (variant.index > 1 ? " " + variant.index : "");
}

module.exports = { WatermarkRegistry, createWatermarkRegistry, familyForCameraModel, parseVariant, parseFile, idFor, describe, WATERMARK_DEVICES, VARIANT_ORDER };
