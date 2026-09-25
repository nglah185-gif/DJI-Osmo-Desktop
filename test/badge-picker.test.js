"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { variantLabel, sections, findEntry } = require("../src/renderer/badge-picker");

// A translator stand-in that keeps the key and its parameters readable.
const t = (key, params) => key + (params ? ":" + JSON.stringify(params) : "");

test("each style reads as the artwork it stands for", () => {
  assert.equal(variantLabel({ kind: "standard", index: 1 }, t), "watermark.styleMark");
  assert.equal(variantLabel({ kind: "standard", index: 2 }, t), "watermark.styleWordmark");
  assert.equal(variantLabel({ kind: "standard", index: 3 }, t), "watermark.styleGlyph");
  assert.equal(variantLabel({ kind: "borderless", style: null }, t), "watermark.styleBorderless");
  assert.equal(variantLabel({ kind: "borderless", style: 2 }, t), "watermark.styleBorderless 2");
  assert.equal(variantLabel({ kind: "frame", index: 4 }, t), 'watermark.styleFrame:{"n":4}');
  assert.equal(variantLabel({ kind: "seasonal", index: 2 }, t), 'watermark.styleSeasonal:{"n":2}');
  assert.equal(variantLabel({ kind: "partner", brand: "huawei_watch_gt_6" }, t), "watermark.stylePartner · HUAWEI WATCH GT 6");
  assert.equal(variantLabel(null, t), "watermark.styleMark", "a missing variant is the base design");
});

test("the list leads with the clip's own device and then every other one", () => {
  const matched = [{ id: "a1", family: "Action4", familyName: "DJI Osmo Action 4" }];
  const catalog = [
    { family: "Action4", name: "DJI Osmo Action 4", entries: [{ id: "a1" }, { id: "a2" }] },
    { family: "Pocket3", name: "DJI Osmo Pocket 3", entries: [{ id: "p1" }] }
  ];
  const groups = sections({ matched, catalog });
  assert.deepEqual(groups.map(group => group.family), ["Action4", "Pocket3"]);
  assert.equal(groups[0].entries.length, 1, "the own device uses the matched set, not the whole group");
  assert.equal(groups[0].own, true);
  assert.equal(groups[1].own, false);
});

test("an unknown camera still gets the whole catalogue", () => {
  const catalog = [{ family: "Pocket3", name: "DJI Osmo Pocket 3", entries: [{ id: "p1" }] }];
  const groups = sections({ matched: [], catalog });
  assert.deepEqual(groups.map(group => group.family), ["Pocket3"]);
  const empty = sections({ matched: [], catalog: [{ family: "Action4", name: "x", entries: [] }] });
  assert.deepEqual(empty, [], "a group with nothing in it is not shown");
});

test("the control finds the chosen badge in either half of the list", () => {
  const matched = [{ id: "a1" }];
  const catalog = [{ family: "Pocket3", entries: [{ id: "p1" }] }];
  assert.equal(findEntry("a1", { matched, catalog }).id, "a1");
  assert.equal(findEntry("p1", { matched, catalog }).id, "p1");
  assert.equal(findEntry("none", { matched, catalog }), null);
  assert.equal(findEntry("", { matched, catalog }), null);
});
