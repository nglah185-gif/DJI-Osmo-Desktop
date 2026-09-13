# I18N Completion V2

## Status

COMPLETE.

English and Simplified Chinese are supported with English as the default and persistence through the dji-osmo-language key. Runtime switching is available without reload. All user-visible static strings in the shell, storage, media library, preview source, editor controls, player state, color and look options, timeline controls, watermark label, language picker, and facts panel are registered keys.

## Registers and runtime

- src/i18n/en.js and src/i18n/zh-CN.js are the single source of truth and are isomorphic: they export messages under CommonJS and publish window.__I18N_EN__ / window.__I18N_ZH__ in the browser.
- src/i18n/index.js exports createTranslator for tests and exposes window.i18n with t(key, vars), getLanguage, setLanguage, and apply.
- Missing zh-CN keys fall back to English and then to the key itself.
- Variable interpolation is implemented for templates such as media.clipCount and scan.files.

## Coverage migrated this pass

- Editor controls: Color, Look, In, Out, Speed, Rotate, Crop, Flip H, Flip V, Volume, Mute, Action 4 watermark.
- Preview mode buttons: Browse LRF / Edit Original.
- Facts panel labels and initial status.
- Scan progress stages (DETECTING_STORAGE, SCANNING_MEDIA, MATCHING_MEDIA, READY).
- Error prefix and media library clip count through t() calls in renderer-phase3.js.
- Dynamic titles (clip count and preview title) no longer get overwritten by static data-i18n application; renderer repaints on languagechange.

## Verification

- npm test: 31 pass, 0 fail.
- New integrity tests: matching en/zh key sets, interpolation, English fallback, HTML data-i18n key coverage, renderer static keys, isomorphic browser globals.
- Electron renderer console shows no JavaScript errors; only the standard development Content-Security-Policy warning.
