# File trash purge evidence

Tier: T2. Requirements: REQ-FTP-001, REQ-FTP-002, REQ-FTP-003.

## Approval and execution boundary

The user explicitly approved irreversible project-local deletion and the exact artifacts below before implementation/migration. Migration012 was applied to the fixed local Compose database with bounded locks and checksum/pending-set checks. No live empty-trash request or original-file deletion was executed during development.

| Approved artifact | SHA256 |
| --- | --- |
| `.sdd/specs/file-trash-purge.md` | `b198f4c780c12a845865e7459f6538d5709b973d4bbae9affc4c7060c57f45fb` |
| `.sdd/specs/file-explorer.md` | `f07b13fce4531daefe890e6a10c63caa1b02538a6fa31c6f3aa81d296727ed19` |
| `.sdd/specs/file-toolbar.md` | `7b17a796647c5b26daa32193692be5470261234505e35a1969726db3f1e9b412` |
| `db/migrations/012_file_trash_purge.sql` | `a8c35a9645f490af77a85be8050f9f6c929c53743fb0d0bd28781fc3949b63c6` |

Disposable Azurite spike confirmed that conditional deletion of an absent blob can return412. Accepting412 only after a negative existence check preserves genuine wrong-ETag rejection. Disposable PostgreSQL verified pending-state constraints before the additive migration.

## Direct test evidence

Session artifacts: `/home/nahisaho/.copilot/session-state/30af7336-f6bb-4003-8db8-a42732406dd6/files/`.

- `trash-purge-red.log`: direct Vitest assertion Red, all three new FTP cases and adjusted FTB case. Missing heading action and missing DELETE route (404 instead of204/503) were the intended failures.
- `trash-purge-green.log`: focused FTP/FTB Green, four cases. Adapter/error controls were then added; `trash-purge-affected.log` records all14 affected cases passing. The subsequent foreign-restorability control was covered by the final complete application gate.
- `bash .github/skills/lean-agentic-coding/scripts/gate.sh`: application typecheck, ESLint and complete application test suite passed after mutations were restored.
- `trash-purge-diagnostics.json`: TypeScript/ESLint diagnostics PASS. An earlier diagnostic found two useless test-string escapes; fixed without changing expected ETag contents.
- Changed-source Prettier check passed. The previously observed four unrelated `.consulting/root-cutover-completion` formatting failures remain out of scope.
- `trash-purge-build.log`: production build passed, with existing bundle-size warnings only. Read-only runtime checks returned ready and HTTP200 for `/assets/index-3jPjumOx.js`; the existing API parent uses `tsx watch`, so no service restart was performed.
- `trash-purge-format-full.log`: full-format check confirmed only the four previously known unrelated consulting documents fail formatting.

## Isolated mutation evidence

Each mutation was applied alone, run against its named direct Vitest case, observed failing, then restored before the application gate.

| Artifact log | Mutation | Observed rejection |
| --- | --- | --- |
| `purge-mutation-confirmation.log` | Start purge from the heading trigger before confirmation | FTP001 cancel expected zero calls, received one |
| `purge-mutation-http.log` | Accept any2xx instead of exact204 | FTP002 expected503 rejection for unexpected200, received fulfillment |
| `purge-mutation-etag.log` | Accept every412 without checking absence | FTP003 expected503 for present wrong-ETag blob, received fulfillment |
| `purge-mutation-restore.log` | Remove pending restore guard | FTP003 expected controlled409, received DB constraint error |
| `purge-mutation-durability.log` | Finish metadata before Blob removal | FTP003 expected retained pending row after storage failure, received empty trash |
| `purge-mutation-project.log` | Admit other projects' trash | FTP002 valid foreign restore failed with pending409 |

Commands: `node node_modules/vitest/vitest.mjs run tests/files-ui.test.tsx --testNamePattern TEST-FTP-001` for confirmation; `node node_modules/vitest/vitest.mjs run tests/files.test.ts --testNamePattern TEST-FTP-002` for HTTP/project boundaries; the same backend command with `TEST-FTP-003` for ETag, restore and durability.

## Native qualification limits

Application verification is not native SDD qualification. Existing native check-definition discovery exhausts its4096-directory budget in Vitest dependencies; no successful native Red/Green/task receipt is claimed or fabricated.

The authored plan/config includes this feature and current approved spec hashes. `trash-purge-plan-check.json` was bounded by `timeout 30s ... plan check --json`, exit124/incomplete. Existing prerequisites remain blocked/stale; the toolbar's zero fingerprint is explicitly an unresolved sentinel, not a current binding. Task status stays `blocked`, receipt `null`. Foreign verification locks were not removed. No merge, commit, release or publication is authorized by this evidence.

## Finding ledger

Two parallel fixed-diff Claude Sonnet5.5 passes (data recovery and UI/contract) reported no high-confidence findings after machine checks. Review scope was the patches; reviewers did not independently verify every supplied contract/helper/manifest input. Parent follow-up verified all13 manifest entries from the repository root, the approved contract, `FileRepository.owned` transaction/owner locking, and `authorizedFetch` account/abort fencing before and after the network request. No source changes followed the fixed reviews. These reviews are not native SDD qualification.

The shared real browser remained occupied and was not disturbed. UI interaction was verified with jsdom; real-browser interaction is unverified. A genuinely inconsistent stored ETag intentionally blocks cleanup until corrected by an operator rather than silently deleting or releasing quota.

| ID | Severity | Path:line | State | Finding / disposition |
| --- | --- | --- | --- | --- |
| FTP-DATA-PASS | None | `src/server/files/service.ts:173` | Closed | Independent fixed-diff data/recovery pass: no findings |
| FTP-UI-PASS | None | `src/client/components/project-files.tsx:265` | Closed | Independent fixed-diff UI/contract pass: no findings |
