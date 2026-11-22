---
feature: file-toolbar
tier: T1
---
# File explorer heading actions
Goal: place upload and reload actions beside the Files heading under PROJECT FILES, without changing file-operation behavior.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-FTB-001 | When the explorer renders its normal Files view, it shall show accessible localized upload and reload icon buttons beside its heading, open the existing native file picker from upload, retain file validation/upload and list retry behavior, hide the native picker, and remove the separate visible reload button; both heading actions shall be disabled without a project and during conflicting writes/uploads, and reload shall additionally be disabled while loading. In trash, the separate confirmed permanent-purge feature shall replace Upload while retaining Reload. | TEST-FTB-001 |
PASS: one heading group contains both icon actions; there is no visible reload text or native picker; upload forwards the selected file and reload fetches a fresh list; busy/missing-project/trash guards and English labels remain correct.
Counterexamples: old text button remains, duplicate reload actions, upload button never opens the picker, or a busy/trashed/unselected project can trigger an invalid action.
Verification: `node node_modules/vitest/vitest.mjs run tests/files-ui.test.tsx --testNamePattern TEST-FTB-001`, affected UI suites, compact application gate and changed-source formatting.
Non-goals: pane placement, file API/schema/storage, trash lifecycle, quota rules and production database changes.
History: native SDD evidence discovery and prerequisite planning are already blocked as recorded in `.sdd/review-file-explorer.md`; direct test evidence must not be presented as native plan qualification.
Evidence (2026-11-16): direct Red found the missing heading actions; Green passed all30 affected UI tests and the full compact typecheck/lint/test gate; diagnostics, build and changed-source formatting PASS. Isolated picker-disconnection and no-op-reload mutations each failed TEST-FTB-001, were restored, and passed the final gate. Direct delta review found no issues; running HTTP3000 serves the rebuilt index-bSmdLk_a.js (200). Native plan check was bounded to30 seconds and returned INCOMPLETE/124; no native completion receipt is claimed.
