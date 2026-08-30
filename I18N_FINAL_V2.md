# I18N Final V2

## Coverage

- English default with zh-CN; persisted through dji-osmo-language; switch without reload.
- All static user-visible strings in the rebuilt UI are data-i18n keys: header, library, preview, mode toggle, all seven inspector sections, export panel, player controls, timeline, and empty/error states.
- Dynamic strings use t(key, vars): clip count, scan stages, error prefix, export running/done, thumbnail placeholders.
- Lookup order: active language, English, then the key itself; interpolation implemented for {var} templates.

## Integrity

- en and zh-CN key sets are equal and non-empty; the HTML data-i18n inventory and the renderer static keys are covered by tests; the browser registries are exposed as window.__I18N_EN__/__I18N_ZH__ with CommonJS export in Node.
- Remaining English literals are technical identifiers: LRF, Original (source badge), AAC, codec names, and the developer Mode/Source/Type debug line.
