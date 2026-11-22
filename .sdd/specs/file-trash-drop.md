---
feature: file-trash-drop
tier: T1
approval: auto
---
# Drag loaded project files to reversible trash
Goal: add a pointer shortcut to existing file trash; preserve menus, keyboard activation, current layout and permanent-delete confirmation.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-FTD-001 | When a user drags a loaded active file onto the current explorer's Trash button, the UI shall highlight the eligible target and invoke the existing reversible trash action exactly once on drop, removing the row and closing its tab only after success, retaining both with an error on failure. | TEST-FTD-001 |
| REQ-FTD-002 | If a drag is external, unknown, canceled, from another project/account session or a trash row, or the explorer is loading/uploading/writing/downloading, the UI shall reject it without a file mutation; accepted gestures shall require a current local drag, matching transfer ID and currently loaded file, and clear after drop/end or loss of eligibility. | TEST-FTD-002 |
## Design
Use native HTML drag events on active rows, a private MIME transfer ID and a component-local file/session reference, never a transferred project/object key. Drag-over checks types/local eligibility, not protected payload data; drop validates the ID and delegates to changeTrash.
Trash is a drop target only in active Files, with visual feedback and a localized hint. Existing menu deletion remains the keyboard/touch fallback. No API, schema, quota, restore or purge-policy change.
## PASS conditions and counterexamples
`REQ-FTD-001`: one valid drop, delayed failure/success and duplicate events verify exact project/file/true write, retained row/tab on rejection and successful tab disposal. Counterexample: optimistic removal, double request, emptyTrash/upload called.
`REQ-FTD-002`: OS/forged/canceled/old-scope transfers and busy states perform zero writes; a fresh local valid control still works. Counterexample: trust MIME/UUID alone across scopes, accept trash rows, read protected payload during drag-over.
Verification: `node node_modules/vitest/vitest.mjs run tests/files-ui.test.tsx --testNamePattern TEST-FTD-`; restored bounded mutations, diagnostics, changed formatting, complete application gate and build. Native planning/TDD qualification remains separately reported if pre-existing discovery/prerequisite blockers persist.
## Assumptions / risks
The requested drag is one existing project file onto the existing Trash button, not an OS upload or multiple selection (not currently present). TEST-FTD-002 rejects external drops. Moving to trash stays reversible and retains quota; permanent empty-trash is unchanged. Cross-browser/touch drag is not guaranteed; retain the accessible menu fallback.
## Evidence (2026-11-16)
Session artifacts: `/home/nahisaho/.copilot/session-state/30af7336-f6bb-4003-8db8-a42732406dd6/files/trash-drop-*`.
Direct `vitest run tests/files-ui.test.tsx --testNamePattern TEST-FTD-`: Red (both cases missing draggable behavior) then Green (two cases); the complete file UI suite passed all9 cases.
Four isolated restored mutations were detected: missing drop-to-trash wiring (FTD001), accepting mismatched transfer IDs, dropping while loading, and retaining a canceled drag (FTD002). Commands/results are in the matching `mutation-*.log` artifacts; all production mutations were restored.
An isolated real-browser context mounted the actual component and used native locator dragTo: one correct reversible write with AbortSignal, one success callback, no accidental open/page errors. APIs were mocked and live API requests blocked; only that context was closed.
Application typecheck/lint/full-test gate and production build passed. `FLAKY suspected`: the first gate, concurrent with build, timed out at the new test's default1-second initial-file lookup; explicit project readiness and5-second condition deadlines fixed the test without changing behavior assertions. The failure and subsequent fixed gate log are retained.
Native plan check was bounded to30 seconds and exited124/incomplete; prerequisite/discovery blockers from prior work persist. Authored task stays blocked with null receipt; no native TDD/task qualification, merge or release is claimed. No live file operation, dependency installation or unrelated service restart occurred.
