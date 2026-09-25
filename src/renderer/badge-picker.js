(() => {
  // Labels and structure for the badge picker. Pure, so the grouping and the
  // translation rules stay unit tested; the DOM wiring lives in
  // renderer-phase3.js.
  //
  // A badge is artwork that differs from its neighbours in small ways -- the logo
  // mark versus the wordmark, the frame drawn around it, the watch it names -- so
  // a list of names could not tell them apart. Every row therefore carries its
  // own preview, and the list is grouped by device.

  // The numbered base designs. Confirmed against the artwork: 1 is the DJI mark
  // plus the model name, 2 is the wordmark alone, 3 swaps the mark for a camera
  // glyph.
  const BASE_STYLE = { 1: "watermark.styleMark", 2: "watermark.styleWordmark", 3: "watermark.styleGlyph" };

  function brandLabel(brand) { return String(brand || "").replace(/_/g, " ").toUpperCase(); }

  function variantLabel(variant, t) {
    const value = variant || { kind: "standard", index: 1 };
    if (value.kind === "borderless") return t("watermark.styleBorderless") + (Number(value.style) > 1 ? " " + value.style : "");
    if (value.kind === "frame") return t("watermark.styleFrame", { n: value.index });
    if (value.kind === "seasonal") return t("watermark.styleSeasonal", { n: value.index });
    if (value.kind === "partner") return t("watermark.stylePartner") + " \u00b7 " + brandLabel(value.brand);
    return t(BASE_STYLE[value.index] || "watermark.styleStandard");
  }

  // A tile's caption: the treatment in as few words as possible, because the
  // artwork above it is the real label. Long captions would compete with it.
  function tileLabel(variant, t) {
    const value = variant || { kind: "standard", index: 1 };
    if (value.kind === "partner") return brandLabel(value.brand);
    if (value.kind === "borderless") return t("watermark.styleBorderless");
    if (value.kind === "frame") return t("watermark.styleFrame", { n: value.index });
    if (value.kind === "seasonal") return t("watermark.styleSeasonal", { n: value.index });
    return t(BASE_STYLE[value.index] || "watermark.styleStandard");
  }

  // The list the menu shows: the open clip's own device first, then every other
  // device. Detection can only read what a file carries, and a badge is a
  // cosmetic choice, so a missing model must never be a dead end.
  function sections({ matched = [], catalog = [] } = {}) {
    const groups = [];
    const mine = Array.isArray(matched) ? matched : [];
    if (mine.length) groups.push({ family: mine[0].family, name: mine[0].familyName, entries: mine, own: true });
    const ownFamilies = new Set(mine.map(entry => entry.family));
    for (const group of Array.isArray(catalog) ? catalog : []) {
      if (ownFamilies.has(group.family) || !group.entries || !group.entries.length) continue;
      groups.push({ family: group.family, name: group.name, entries: group.entries, own: false });
    }
    return groups;
  }

  // Which entry the control is showing. Falls back to the plain value when the
  // selection is not in either list, so the button never goes blank silently.
  function findEntry(value, { matched = [], catalog = [] } = {}) {
    const wanted = String(value || "");
    for (const entry of matched) if (entry.id === wanted) return entry;
    for (const group of catalog) for (const entry of group.entries) if (entry.id === wanted) return entry;
    return null;
  }

  const api = { BASE_STYLE, brandLabel, variantLabel, tileLabel, sections, findEntry };
  if (typeof window !== "undefined") window.__badgePicker = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
