"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWatermarkRegistry, familyForCameraModel, parseVariant, parseFile, idFor, describe } = require("../src/watermark/watermark-registry");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function rootWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dji-wm-"));
  const dir = path.join(root, "watermark");
  fs.mkdirSync(dir);
  for (const name of files) fs.writeFileSync(path.join(dir, name), PNG);
  return root;
}

const FIXTURE = [
  "pic_watermark_oa4_1.png", "pic_watermark_oa4_2.png", "pic_watermark_oa4_3.png",
  "pic_watermark_oa4_borderless.png", "pic_watermark_oa4_coros.png",
  "pic_watermark_new_year_oa4_1.png", "pic_watermark_new_year_oa4_2.png",
  "pic_watermark_oa5pro_1.png", "pic_watermark_oa5p_borderless.png",
  "pic_watermark_o360_filter_1.png", "pic_watermark_o360_2_filter_1.png",
  "pic_watermark_op3_1.png", "pic_watermark_520_1.png", "pic_watermark_none.png"
];

test("the style suffix is parsed into a kind, a style number and a paired device", () => {
  assert.deepEqual(parseVariant("1"), { kind: "standard", index: 1 });
  assert.deepEqual(parseVariant("2"), { kind: "standard", index: 2 });
  assert.deepEqual(parseVariant("borderless"), { kind: "borderless", style: null });
  assert.deepEqual(parseVariant("2_borderless"), { kind: "borderless", style: 2 });
  assert.deepEqual(parseVariant("filter_3"), { kind: "frame", index: 3, style: null });
  assert.deepEqual(parseVariant("2_filter_3"), { kind: "frame", index: 3, style: 2 });
  assert.deepEqual(parseVariant("2_huawei_watch_gt_6"), { kind: "partner", brand: "huawei_watch_gt_6", index: 2 });
});

test("a seasonal badge keeps both its season and its style", () => {
  const seasonal = parseFile("pic_watermark_new_year_o360_2_1.png");
  assert.equal(seasonal.device.family, "Osmo360");
  assert.equal(seasonal.variant.kind, "seasonal");
  assert.equal(seasonal.variant.index, 1);
  assert.equal(seasonal.variant.style, 2);
  assert.equal(idFor(seasonal.device, seasonal.variant), "osmo360.official.o360.2.newyear");
});

test("the two numbered series of one device stay separate ids", () => {
  const first = parseFile("pic_watermark_o360_filter_1.png");
  const second = parseFile("pic_watermark_o360_2_filter_1.png");
  assert.notEqual(idFor(first.device, first.variant), idFor(second.device, second.variant));
  assert.equal(idFor(second.device, second.variant), "osmo360.official.o360.2.frame1");
});

test("the shipping default badge id is unchanged", () => {
  const parsed = parseFile("pic_watermark_oa4_1.png");
  assert.equal(idFor(parsed.device, parsed.variant), "action4.official.oa4");
});

test("every badge file becomes one entry, and the placeholder is not offered", () => {
  const registry = createWatermarkRegistry(rootWith(FIXTURE), { cacheRoot: path.join(os.tmpdir(), "dji-wm-ink") });
  const ids = registry.list().map(entry => entry.id).sort();
  assert.equal(ids.length, FIXTURE.length - 1);
  assert.equal(ids.includes("action4.official.oa4"), true);
  assert.equal(ids.includes("action4.official.oa4.2"), true);
  assert.equal(ids.includes("action4.official.oa4.3"), true);
  assert.equal(ids.includes("action4.official.oa4.borderless"), true);
  assert.equal(ids.includes("action4.official.oa4.coros"), true);
  assert.equal(ids.includes("action4.official.oa4.newyear"), true);
  assert.equal(ids.includes("action4.official.oa4.newyear2"), true);
  assert.equal(ids.includes("action5pro.official.oa5p.borderless"), true, "the short token keeps its own id");
  assert.equal(ids.some(id => id.includes("none")), false, "the placeholder is the UI's own option");
});

test("a device's badges are offered for its footage and grouped in the catalogue", () => {
  const registry = createWatermarkRegistry(rootWith(FIXTURE), { cacheRoot: path.join(os.tmpdir(), "dji-wm-ink") });
  assert.equal(registry.forCameraModel("DJI Osmo Action 4 / HG302").length, 7);
  assert.equal(registry.forCameraModels(["Action 4", "Pocket 3"]).length, 8);
  // The first entry is what the editor opens with, so it must be the plain
  // badge: file order alone put the seasonal ones first.
  assert.equal(registry.forCameraModel("DJI Osmo Action 4")[0].id, "action4.official.oa4");
  assert.equal(registry.forCameraModels(["Action 4", "Pocket 3"])[0].id, "action4.official.oa4");
  const groups = registry.catalog();
  const action4 = groups.find(group => group.family === "Action4");
  assert.equal(action4.name, "DJI Osmo Action 4");
  // Styles first, then the cropped-edge and seasonal versions.
  assert.deepEqual(action4.entries.map(entry => entry.variant.kind), ["standard", "standard", "standard", "borderless", "partner", "seasonal", "seasonal"]);
  assert.equal(describe(action4.entries[0]), "DJI Osmo Action 4");
  assert.equal(describe(action4.entries[3]), "DJI Osmo Action 4 borderless");
  // The novelty badge is a group like any other, but it is read last.
  assert.deepEqual(groups.map(group => group.family), ["Action5Pro", "Action4", "Pocket3", "Osmo360", "LoveIsAction"]);
});

test("camera models map to the device that owns the badge", () => {
  assert.equal(familyForCameraModel("DJI Osmo Action 5 Pro"), "Action5Pro");
  assert.equal(familyForCameraModel("Osmo Nano"), "OsmoNano");
  assert.equal(familyForCameraModel("Osmo 360"), "Osmo360");
  assert.equal(familyForCameraModel("DJI Osmo Mobile 7P"), "Mobile7Pro");
  assert.equal(familyForCameraModel("DJI Osmo Mobile 8"), "Mobile8");
  assert.equal(familyForCameraModel("something else"), null);
});
