# Settings V2

- Settings dialog contains only real features: Language and Export Location.
- Export Location defaults to the user Videos folder, is chosen via the native directory picker, persists through userData/config.json (src/settings/config-store.js) and survives restart.
- Export uses the saved location; Export As lets the user pick any destination for one export without changing the default.
- Language switch applies immediately (i18n) and persists to the same config.
- Config store unit tests cover persistence across reloads and missing-config defaults. CDP smoke: settings opens, export location shows C:\Users\leoevan\Videos.
