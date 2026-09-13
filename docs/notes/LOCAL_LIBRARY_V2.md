# Local Library V2

- Media source switch: Camera / Local Library; lists never mix.
- Local scanner (src/local-library/local-scanner.js) walks chosen folders (MP4, MOV, M4V; read-only) and builds the same MediaAsset shape as the camera (id = local: + path/size/mtime fingerprint; preview UNKNOWN; captureMode STANDARD; thumbnail first-frame).
- Add Folder and Import Files use native Electron dialogs; paths are persisted in config (localRoots); original files are never copied or modified.
- Local assets share Preview (ORIGINAL_FALLBACK proxy), Edit (fallback proxy or LRF-if-present), Color, Creative Look, Watermark, Timeline and Export with camera assets - one editor, no second implementation.
- Thumbnails come from the first-frame chain (no THM/SCR/LRF on local files) with the standard placeholder on failure - no broken images.
- Empty state: "No local media / Add Folder / Import Files". Scanner unit tests cover unified shape, stable fingerprint, and extension restriction.
