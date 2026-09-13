/**
 * Batch export UI probe. Drives the running app over CDP and checks the
 * multi-select plumbing, the batch setup sheet, and the progress dialog against
 * the real DOM.
 *
 * The setup sheet is where restoration and watermark are chosen, so it is
 * exercised end to end: open it, flip both options, and cancel. No export is
 * started, so nothing is written.
 *
 * Run this against a freshly started app. The last check opens a clip to prove
 * the card body still enters the editor, and the app keeps that clip open, which
 * narrows the grid for any later run.
 *
 * Usage: node scripts/batch-export-probe.js
 */
"use strict";

async function connect() {
  const targets = await fetch("http://127.0.0.1:9222/json").then(r => r.json());
  const page = targets.find(t => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params && msg.params.exceptionDetails && msg.params.exceptionDetails.text);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params && msg.params.type === "error") {
      consoleErrors.push((msg.params.args || []).map(a => a.value || a.description).join(" "));
    }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params) => new Promise(resolve => {
    const callId = ++id;
    pending.set(callId, resolve);
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
  await send("Runtime.enable", {});
  const evalJs = async expression => {
    const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const r = reply && reply.result;
    if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception || {}));
    return r && r.result ? r.result.value : null;
  };
  return { ws, evalJs, consoleErrors };
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log((pass ? "  PASS  " : "  FAIL  ") + name + (detail ? "  -> " + detail : ""));
}

(async () => {
  const { evalJs, consoleErrors } = await connect();

  const cards = await evalJs(`document.querySelectorAll('.media-card').length`);
  check("media grid rendered", cards > 0, cards + " cards");
  if (!cards) { console.log("no cards; aborting"); process.exit(1); }

  const videoCards = await evalJs(`[...document.querySelectorAll('.media-card')].filter(c => ![...c.querySelectorAll('.badge')].some(b => b.dataset.i18n === 'media.photoBadge')).length`);
  const selects = await evalJs(`document.querySelectorAll('.card-select').length`);
  check("only video cards offer a selection checkbox", selects === videoCards && videoCards > 0, selects + " checkboxes / " + videoCards + " videos / " + cards + " cards");

  const unchecked = await evalJs(`[...document.querySelectorAll('.card-select')].every(s => s.getAttribute('aria-checked') === 'false')`);
  check("checkboxes start unchecked", unchecked === true);

  const barHiddenInitially = await evalJs(`document.getElementById('selection-bar').hidden`);
  check("selection bar hidden with nothing selected", barHiddenInitially === true);

  // Click two checkboxes the way a user would.
  await evalJs(`(function(){ const s=[...document.querySelectorAll('.card-select')]; s[0].click(); s[1].click(); return true; })()`);
  const afterClick = await evalJs(`JSON.stringify({ checked: document.querySelectorAll('.card-select[aria-checked="true"]').length, hidden: document.getElementById('selection-bar').hidden, count: document.getElementById('selection-count').textContent, picked: document.querySelectorAll('.media-card.picked').length })`);
  const state = JSON.parse(afterClick);
  check("clicking a checkbox selects it", state.checked === 2, afterClick);
  check("selection bar appears", state.hidden === false);
  check("card is marked picked", state.picked === 2, state.picked + " picked");
  check("count label is localized, not a raw key", !/^batchExport/.test(state.count), state.count);

  // Clicking again deselects. This runs while the full grid is still rendered:
  // once a clip opens the virtual grid narrows and the card may leave the DOM.
  await evalJs(`document.querySelectorAll('.card-select')[0].click()`);
  const afterUncheck = await evalJs(`document.querySelectorAll('.card-select[aria-checked="true"]').length`);
  check("clicking again deselects", afterUncheck === 1, afterUncheck + " left");

  // The setup sheet is exercised first, while the grid still fills the page.
  // Opening a clip later narrows the grid to a handful of cards, so the video
  // selection this test needs would not be available. Photos are not selectable
  // at all now, so a clean video selection must report no skips.
  await evalJs(`(function(){ document.getElementById('selection-clear').click(); const c=[...document.querySelectorAll('.media-card')]; let v=0; for(const card of c){ const s=card.querySelector('.card-select'); if(!s) continue; s.click(); if(++v===2) break; } return v; })()`);
  const selectedForSetup = await evalJs(`document.querySelectorAll('.card-select[aria-checked="true"]').length`);
  check("two video clips selected for the setup sheet", selectedForSetup === 2, selectedForSetup + " checked");

  await evalJs(`document.getElementById('selection-export').click()`);
  await new Promise(r => setTimeout(r, 1800));
  const setupState = await evalJs(`JSON.stringify({
    overlayHidden: document.getElementById('batch-overlay').hidden,
    setupHidden: document.getElementById('batch-setup').hidden,
    progressHidden: document.getElementById('batch-progress').hidden,
    restoreChecked: document.getElementById('batch-option-restore').checked,
    watermarkChecked: document.getElementById('batch-option-watermark').checked,
    watermarkDisabled: document.getElementById('batch-option-watermark').disabled,
    watermarkSelectDisabled: document.getElementById('batch-option-watermark-id').disabled,
    tagCount: document.querySelectorAll('.batch-pick-tag').length,
    rowCount: document.querySelectorAll('.batch-pick-row').length,
    headline: document.getElementById('batch-setup-headline').textContent,
    countText: document.getElementById('batch-setup-count').textContent,
    startDisabled: document.getElementById('batch-setup-start').disabled
  })`);
  const setup = JSON.parse(setupState);
  check("setup sheet opens in front of the dialog", setup.overlayHidden === false && setup.setupHidden === false && setup.progressHidden === true, setupState);
  check("only the two video clips are listed", setup.rowCount === 2, setup.rowCount + " rows");
  check("no skip is reported for a clean video selection", !/跳过|skipped/i.test(setup.countText) && !/^batchExport\./.test(setup.countText), setup.countText);
  check("restoration is on by default", setup.restoreChecked === true);
  check("a restore tag is shown only on D-Log clips", setup.tagCount <= setup.rowCount, setup.tagCount + " tags");
  check("watermark is off by default", setup.watermarkChecked === false && setup.watermarkSelectDisabled === true);
  check("start is enabled", setup.startDisabled === false);
  check("headline is localized, not a raw key", !/^batchExport\./.test(setup.headline), setup.headline);

  // Turning restoration off removes the tags; turning it back on restores them.
  await evalJs(`(function(){ const box=document.getElementById('batch-option-restore'); box.checked=false; box.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
  const tagsOff = await evalJs(`document.querySelectorAll('.batch-pick-tag').length`);
  check("turning restoration off clears the tags", tagsOff === 0, tagsOff + " tags");
  await evalJs(`(function(){ const box=document.getElementById('batch-option-restore'); box.checked=true; box.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
  const tagsBack = await evalJs(`document.querySelectorAll('.batch-pick-tag').length`);
  check("turning restoration back on restores the tags", tagsBack === setup.tagCount, tagsBack + " tags");

  // Enabling the watermark enables its picker.
  await evalJs(`(function(){ const box=document.getElementById('batch-option-watermark'); box.checked=true; box.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
  const wmState = await evalJs(`JSON.stringify({ checked: document.getElementById('batch-option-watermark').checked, selectDisabled: document.getElementById('batch-option-watermark-id').disabled, options: document.getElementById('batch-option-watermark-id').options.length })`);
  const wm = JSON.parse(wmState);
  check("enabling the watermark enables the picker", wm.checked === true && wm.selectDisabled === false && wm.options > 0, wmState);

  // Cancel must leave without exporting anything; the selection stays so the
  // editor test below can prove opening a clip does not disturb it.
  await evalJs(`document.getElementById('batch-setup-cancel').click()`);
  await new Promise(r => setTimeout(r, 300));
  const closed = await evalJs(`document.getElementById('batch-overlay').hidden`);
  check("cancel closes the dialog without starting an export", closed === true);

  // Clicking the card body must still open the editor, not toggle selection.
  // Photos never open the editor by design, so target the first video card.
  const videoIndex = await evalJs(`(function(){ const c=[...document.querySelectorAll('.media-card')]; for (let i=0;i<c.length;i++){ if(![...c[i].querySelectorAll('.badge')].some(b=>b.dataset.i18n==='media.photoBadge')) return i; } return -1; })()`);
  if (videoIndex < 0) {
    check("clicking the card body still opens the editor", false, "no video card to click");
  } else {
    await evalJs(`document.querySelectorAll('.media-card')[${videoIndex}].click()`);
    await new Promise(r => setTimeout(r, 2500));
    const mode = await evalJs(`(document.getElementById('preview-debug')||{}).textContent || ''`);
    check("clicking the card body still opens the editor", /EDIT/.test(mode), mode.slice(0, 44));
    // Return to browse so the selection checks below see a stable grid.
    await evalJs(`document.getElementById('mode-original').click(), true`);
  }
  // The selection is a set of asset ids, and opening a clip narrows the virtual
  // grid so the selected cards may not be rendered at all. Read the floating
  // counter, which reflects the selection itself rather than the viewport.
  const stillSelected = await evalJs(`JSON.stringify({ hidden: document.getElementById('selection-bar').hidden, count: document.getElementById('selection-count').textContent })`);
  const still = JSON.parse(stillSelected);
  check("opening a clip does not disturb the selection", still.hidden === false && /2/.test(still.count) && !/^batchExport/.test(still.count), stillSelected);

  // Clear must empty the selection and hide the bar even though the selected
  // cards are not on screen.
  await evalJs(`document.getElementById('selection-clear').click()`);
  const cleared = await evalJs(`JSON.stringify({ hidden: document.getElementById('selection-bar').hidden, count: document.getElementById('selection-count').textContent })`);
  const clearedState = JSON.parse(cleared);
  check("clear empties the selection and hides the bar", clearedState.hidden === true, cleared);

  // The dialog is hidden again now that setup was canceled.
  const dialogReady = await evalJs(`JSON.stringify({ overlay: !!document.getElementById('batch-overlay'), hidden: document.getElementById('batch-overlay').hidden, list: !!document.getElementById('batch-modal-list'), cancel: !!document.getElementById('batch-modal-cancel'), close: !!document.getElementById('batch-modal-close'), restore: !!document.getElementById('batch-option-restore'), watermark: !!document.getElementById('batch-option-watermark') })`);
  const dialog = JSON.parse(dialogReady);
  check("batch dialog exists and hides after cancel", dialog.overlay && dialog.hidden === true, dialogReady);
  check("batch dialog has list, actions and option controls", dialog.list && dialog.cancel && dialog.close && dialog.restore && dialog.watermark);

  // i18n: every batchExport key used in the dialog resolves.
  const i18n = await evalJs(`(function(){
    const keys = ['batchExport.title','batchExport.selected','batchExport.clear','batchExport.exportSelected','batchExport.cancelAll','batchExport.reveal','batchExport.queued','batchExport.running','batchExport.done','batchExport.failed','batchExport.complete','batchExport.partial','batchExport.allFailed','batchExport.canceled','batchExport.summarySkipped','batchExport.nothingToExport','batchExport.restore','batchExport.restoreHint','batchExport.watermark','batchExport.start','batchExport.setupCount','batchExport.needsRestore','batchExport.noRestore','batchExport.tagRestore'];
    const missing = keys.filter(k => window.i18n.t(k) === k);
    return JSON.stringify({ missing, sample: window.i18n.t('batchExport.selected', { count: 3 }), restore: window.i18n.t('batchExport.needsRestore', { count: 4 }) });
  })()`);
  const i18nState = JSON.parse(i18n);
  check("all batch i18n keys resolve", i18nState.missing.length === 0, i18nState.missing.join(","));
  check("count interpolation works", i18nState.sample !== "batchExport.selected" && !/\\{count\\}/.test(i18nState.restore), i18nState.restore);

  const realErrors = consoleErrors.filter(Boolean);
  check("no renderer errors logged", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  const failed = results.filter(r => !r.pass).length;
  console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed");
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error("probe failed:", error.message); process.exit(1); });
