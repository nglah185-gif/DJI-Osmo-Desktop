"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { icons, get, hydrateIcons } = require("../src/renderer/icons");

const rendererDir = path.join(__dirname, "..", "src", "renderer");
const readRenderer = name => fs.readFileSync(path.join(rendererDir, name), "utf8");

test("the icon set is non-empty and every entry is a well-formed svg", () => {
  const names = Object.keys(icons);
  assert.ok(names.length >= 10, "expected a full set, got " + names.length);
  for (const name of names) {
    const svg = icons[name];
    assert.match(svg, /^<svg /, name + " must start with an svg element");
    assert.match(svg, /<\/svg>$/, name + " must close its svg element");
    // Shared box and accessibility attributes, so sizing lives in CSS and no
    // screen reader announces a decorative glyph.
    assert.match(svg, /viewBox="0 0 24 24"/, name + " must use the shared 24x24 box");
    assert.match(svg, /class="icon"/, name + " must carry the .icon class");
    assert.match(svg, /aria-hidden="true"/, name + " must be hidden from assistive tech");
    assert.match(svg, /focusable="false"/, name + " must not be focusable");
    // Size belongs to layout, so the root svg must not carry width/height. Only
    // the opening tag is checked: width/height on a <rect> inside is geometry.
    const openingTag = svg.slice(0, svg.indexOf(">") + 1);
    assert.doesNotMatch(openingTag, /(?<![-\w])(width|height)="/, name + " must not hard-code a size");
    // currentColor is what lets one icon serve the muted, normal and accent
    // states without a per-state copy.
    assert.match(svg, /currentColor/, name + " must paint with currentColor");
    assert.equal((svg.match(/<svg/g) || []).length, 1, name + " must contain exactly one svg");
  }
});

test("get returns an icon by name and an empty string for anything else", () => {
  assert.equal(get("play"), icons.play);
  assert.equal(get("nonexistent"), "");
  assert.equal(get(undefined), "");
});

test("every data-icon declared in index.html exists in the set", () => {
  const html = readRenderer("index.html");
  const used = [...html.matchAll(/data-icon="([a-z]+)"/g)].map(match => match[1]);
  assert.ok(used.length >= 6, "expected the static markup to declare icons, found " + used.length);
  const missing = used.filter(name => !icons[name]);
  assert.deepEqual(missing, [], "index.html references unknown icons: " + missing.join(", "));
});

test("every icon the renderer requests at runtime exists in the set", () => {
  const source = readRenderer("renderer-phase3.js");
  const requested = [...source.matchAll(/iconSet\.get\("([a-z]+)"\)/g)].map(match => match[1]);
  const missing = requested.filter(name => !icons[name]);
  assert.deepEqual(missing, [], "renderer requests unknown icons: " + missing.join(", "));
  // The play/pause pair and the empty-state glyph are the runtime swaps; if the
  // set ever loses one the control silently renders blank. The spinner is
  // picked inside a ternary, so it is checked by name in the source rather than
  // by the literal-argument pattern above.
  for (const name of ["play", "pause", "close"]) assert.ok(requested.includes(name), name + " should be requested at runtime");
  assert.match(source, /"spinner"/, "the empty-state glyph should offer a spinner");
});

test("no raw emoji or text glyph survives as an icon", () => {
  const html = readRenderer("index.html");
  const source = readRenderer("renderer-phase3.js");
  // These were the pre-refactor stand-ins: an OS colour emoji, a dotted circle
  // and text symbols. They rendered at whatever weight the resolved font had,
  // which is why the toolbar looked inconsistent.
  for (const [label, text] of [["index.html", html], ["renderer-phase3.js", source]]) {
    for (const glyph of ["\u{1F310}", "\u25CC", "\u21BB", "\u22EF", "\u2716"]) {
      assert.equal(text.includes(glyph), false, label + " still contains the raw glyph " + JSON.stringify(glyph));
    }
  }
});

test("hydrate fills declared elements and ignores unknown names", () => {
  const created = [];
  const makeElement = name => ({
    dataset: { icon: name },
    set innerHTML(value) { created.push([name, value]); },
    get innerHTML() { return ""; }
  });
  const root = { querySelectorAll: () => [makeElement("play"), makeElement("does-not-exist")] };
  hydrateIcons(root);
  assert.equal(created.length, 1, "an unknown icon name must not clear the element");
  assert.equal(created[0][0], "play");
  assert.equal(created[0][1], icons.play);
});

test("hydrate is a no-op when nothing declares an icon", () => {
  assert.doesNotThrow(() => hydrateIcons({ querySelectorAll: () => [] }));
});
