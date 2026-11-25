---
feature: file-explorer
tier: T2
approval: human
---
# Compact file explorer and reversible trash
Goal: retain the existing pane placement; show filename-only rows alphabetically, with a vertical-ellipsis menu and central file opening.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-FEX-001 | When active file pages load, the explorer shall sort all currently loaded filenames alphabetically (case-insensitive, deterministic ID tie-break), show only the filename and an accessible vertical-ellipsis action button per row, open the existing central same-ID tab on filename activation, and offer original-byte download and deletion in the menu without opening the file. | TEST-FEX-001 |
| REQ-FEX-002 | When an authenticated owner deletes or restores a ready file not committed to an explicitly confirmed permanent purge, the server shall persist a reversible trash timestamp under its tenant/object/project lock, retain UUID/name/bytes/hash/ETag and quota usage, exclude trash from normal listing/content, paginate an owner-only trash listing, and allow idempotent trash/restore; malformed, unknown, foreign-project, foreign-owner, foreign-tenant and non-ready files shall return 404 without mutation. | TEST-FEX-002 |
| REQ-FEX-003 | When deletion succeeds, the explorer shall remove that row and close its central tab; the project-local trash view shall offer restore and return the same file to the active list after reload without reopening its tab. Failed operations shall show an error without removing rows/tabs; writes and view changes shall abort/fence prior list pages, prevent duplicate writes, fence old user/project completions and route current-session 401 to authentication recovery. Menus shall support keyboard operation and localized labels without translating filenames. | TEST-FEX-003 |
## Design
Add nullable `project_files.trashed_at` via an additive migration; ready/failed/uploading states remain unchanged and quota includes retained trash. Ordinary deletion remains reversible; the separately confirmed file-trash-purge feature is the only explicit permanent-deletion extension. No automatic expiry or retention policy.
Keep existing list cursor/order/API defaults; `?trashed=true` selects trash. Client sorts the loaded active or trash rows after each page. Unloaded pages still require the existing Load more action.
Add owner-locked repository/service `setTrashed`, authenticated DELETE file (trash) and POST file/restore, returning 204. Explicit purge admission and restore serialize on that same project row lock; restore updates atomically require NOT purge_pending, while re-trashing pending files remains idempotent and can never clear pending. Invalid query values return 400; both lists are ready-only and content only opens non-trashed ready files. Duplicate filenames remain allowed, including restore.
Add required FilesApi.setTrashed and optional fourth list argument for trash; existing download integrity and account checks remain mandatory. Use Radix DropdownMenu as in project settings.
Toggle Files/Trash in the explorer, retaining upload/quota/retry; trash rows expose restore, not preview/download. Disable paging/reload/view changes/uploads during writes, abort prior list pages before writes/view changes, and ignore aborted results.
Expose WorkspaceTabs.closeFile, reusing existing neighbor selection/resource disposal; notify App only after current-scope trash success. Pane placement remains unchanged.
Policy table: ready-active × trash→ready-trash; ready-active × restore→same; ready-trash (not pending) × trash→same; ready-trash (not pending) × restore→ready-active; purge-pending × trash→same/pending; purge-pending × restore→409; uploading/failed/missing/foreign × either→404. Trashed content→404.
## PASS conditions and counterexamples
`REQ-FEX-001`: shuffled mixed-case names and duplicate names sort without mutating API data; menu does not open a tab; filename opens center; no per-row size/download text before opening menu. Counterexample: arrival-order rows or menu click opens file.
`REQ-FEX-002`: actual PostgreSQL/Azurite trash/restart/restore preserves original bytes and quota; full quota with trash still rejects uploads; exercise every policy row and both identity dimensions. Counterexample: trash bytes still downloadable, quota bypass, foreign mutation, lost restore.
`REQ-FEX-003`: success closes only affected tab; restore survives reload; rejection retains row/tab; delayed old-scope completion cannot change new project. Counterexample: optimistic disappearance or stale callback.
Verification: native TDD for TEST-FEX-001/002/003; files/UI regression suites, typecheck, lint, formatting, build and SDD gate. No release, live database migration or production data operation is authorized.
## Assumptions and spike
User initially selected reversible trash and unchanged pane placement. The later file-trash-purge feature adds separately confirmed permanent empty-trash and quota release; ordinary trash still consumes quota and no automatic purge is introduced.
2026-11-16: disposable PostgreSQL via tests/helpers/database.ts accepted ADD COLUMN trashed_at timestamptz (one column observed), then transaction rolled back and test container closed.
History/qualification: existing implementation-plan has unrelated pending/stale work; report native plan/gate verdict separately from focused behavior tests; never claim a release.
