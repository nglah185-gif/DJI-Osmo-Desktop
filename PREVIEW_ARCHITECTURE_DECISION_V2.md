# PREVIEW_ARCHITECTURE_DECISION_V2

## Final decision

**RECOMMEND ELECTRON**, with an immediate preview state-machine fix and a measured GPU-preview follow-up. Do not migrate the application to Tauri merely to replace Electron.

## Ten bottleneck answers

1. **Historical biggest bottleneck (fixed):** preview restart correctness: `session.stopping` could remain true after update/seek, and late child events could race a replacement stream. The current generation-guarded state machine no longer reproduces this in the real stress run.
2. **Is LUT the main bottleneck?** No. Backend B/C/E sustain 103/78/57 fps versus a 29.97 fps source.
3. **Is Canvas the main bottleneck?** No at 640x360; measured paint is 0.73-0.80 ms. It is a scaling concern.
4. **Is JavaScript the main bottleneck?** No at current resolution. It does cause avoidable RGB-to-RGBA copies and state complexity.
5. **Is IPC the main bottleneck?** Not currently, but 691,200 B/frame and 19.5-21.2 MB/s is the principal resolution-scaling limit.
6. **Is FFmpeg wrongly in realtime preview?** No. The long-lived FFmpeg process keeps up. Per-frame FFmpeg spawning would be wrong and measures only 2-4 fps.
7. **Is GPU used?** Hardware decode is feasible and Chromium composites the canvas, but the effect preview uses no custom GPU LUT/render path.
8. **Does Tauri clearly improve performance?** No. Full real-frame WebView2 results are unavailable; the Rust boundary merely matches source rate, which Electron already does.
9. **Is a Rust core worth migrating now?** Not as a wholesale rewrite. A narrow core is worth reconsidering only with a defined zero-copy/GPU contract.
10. **Is a native GPU renderer required?** Not for 640x360/30 today. It is the credible route for high-resolution, high-frame-rate, zero-copy preview later.

## Option evaluation

| Criterion | A Electron + GPU preview later | B Tauri + WebView2 + Rust | C Native Rust UI/GPU |
|---|---|---|---|
| Current performance | Meets source rate | Unproven end-to-end | Potentially best |
| Development cost | Lowest | High | Highest |
| Migration risk | Lowest | High | Very high |
| UI productivity | Highest with current code | Similar web UI, rewritten bridge | Lowest initially |
| Windows integration | Already working | Good but must be rebuilt | Full control, full burden |
| GPU/video ceiling | High with narrow native core | WebView boundary still matters | Highest |
| Evidence-backed choice | **Yes** | No | No current need |

## Required next actions

1. **Completed:** reset `session.stopping` before replacement launches and guard stdout/timers/close events with a generation token.
2. **Completed:** real-window effect-switch stress requires a visible new frame; 30 rapid filter/watermark operations completed without `preview:error`.
3. Keep a longer memory-soak run as follow-up; current unit and real-window checks cover cleanup and bounded child lifetime, but a multi-hour RSS budget is UNAVAILABLE.
4. Prototype GPU presentation only after the corrected 640x360 and 720p baselines are recorded.
5. Require zero-copy/shared-surface evidence before approving any Rust/Tauri migration.

This recommendation follows Situation A/C from the task rules: the existing pipeline keeps up and the measured problem is in preview control/state, while Tauri has not shown a clear end-to-end advantage.
