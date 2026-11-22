# File explorer change evidence

| ID | Severity | Location | State | Resolution |
| --- | --- | --- | --- | --- |
| FEX-SPEC-001 | design | .sdd/specs/file-explorer.md:28 | Accepted | Trash retains quota and has no purge; explicitly presented with the exact specification hash and approved by nahisaho. |
| FEX-SPEC-002 | correctness | src/client/components/project-files.tsx:233 | Fixed | Abort pending pages before a trash write or view switch; reject aborted and old-session write results. Restored mutation removing write-time abort failed TEST-FEX-003 as expected. |
| FEX-TOOL-001 | tooling | .github/skills/lean-sdd-tdd/scripts/sdd.mjs:5871 | Deferred | Native Red (all three TEST-FEX IDs) and gate --changed refuse discovery beyond 4096 directories in node_modules/vitest. No native TDD evidence or successful task receipt is claimed or fabricated. Direct assertion Red and restored-mutation logs are retained in the session artifacts. |
| FEX-PLAN-001 | tooling | .sdd/implementation-plan.json:1 | Deferred | Baseline plan check already failed on stale prerequisites and an occupied user-preferences verification lock. New file-explorer-actions task remains honestly blocked with no receipt; do not modify another operation's lock or repair unrelated tasks. |
| FEX-FORMAT-001 | tooling | .consulting/root-cutover-completion/analysis-brief.md:1 | Deferred | Full format:check fails on this pre-existing file plus hypothesis-evidence-ledger.md, issue-tree.md and synthesis-handoff.md in the same directory. Every changed supported source artifact passes formatting. |

Approval: `.sdd/specs/file-explorer.md`, SHA256 `fbafe0630a8302992193180d1ac4dd44568e4b4a3ee6f18282ff7d7f45bb87a2`; unchanged after explicit human approval. Scope retains pane placement, sorts loaded pages and implements reversible trash only.

Verification observed on 2026-11-16:
- Direct Red: `node node_modules/vitest/vitest.mjs run tests/files-ui.test.tsx --testNamePattern TEST-FEX-` failed assertions for row ordering and the absent file menu; backend `TEST-FEX-002` failed with expected204/actual404 before implementation.
- Green: focused three TEST-FEX regressions passed; full `npm test` passed 105 tests in25 files; affected six-suite rerun after final edits/restored mutations passed49 tests.
- `sdd.mjs diagnostics --root . --json`: PASS (TypeScript5.9 and ESLint9, no diagnostics). `npm run build`: PASS (existing chunk-size warning). Changed-source Prettier check: PASS.
- Five isolated mutations each failed the intended assertion, then were restored: reversed alphabetical comparator (TEST-FEX-001); omitted content trash filter (expected404/actual200); omitted mutation project predicate (expected404/actual204); excluded trash from quota (expected31/actual0); omitted write-time list abort (expectedtrue/actualfalse). No mutation remains in production.
- Logs and original production snapshots: `/home/nahisaho/.copilot/session-state/30af7336-f6bb-4003-8db8-a42732406dd6/files/file-explorer-*`.
- At implementation handoff, SDD full qualification was not established and no live database migration, release, publication or commit had been performed. The separately approved runtime recovery below subsequently applied migration011.
- Final compact application gate (`bash .github/skills/lean-agentic-coding/scripts/gate.sh`): PASS for typecheck, lint and the full test suite; no application check was skipped.
- Independent Claude Sonnet5.5 implementation reviews: backend/API persistence and identity boundaries — no findings; UI/state/contract/test adequacy — no findings. Final delta contains no unresolved product-code finding.
- Optional browser smoke: isolated loopback Vite server responded HTTP200, but Playwright refused because its shared browser profile was already occupied. No browser interaction result is claimed, no other user's browser was closed, and the temporary Vite server was stopped. Actual UI behavior remains covered by the passing jsdom integration tests.
- Native `plan verify file-explorer-actions --json`: FAIL on stale prerequisite bindings/incomplete prerequisite verification and the explicitly blocked task. Failure receipt retained at `.sdd/plan-evidence/ff09268faf77269e879718b17678ff1a8d4eb65a8a8e95125e1cb32317596f7a/4feeb1338fda0f5307fbf07eb2e0674e8f9f327641430105617a0503962c7a31.json`; no completion receipt adopted.

## Follow-up runtime recovery

FEX-RUNTIME-001 | runtime | db/migrations/011_file_trash.sql:1 | Fixed

After the user reported file-operation failures, read-only inspection confirmed that the running repository Compose database had migrations001..010 only and no `project_files.trashed_at` column. No data or schema was changed during diagnosis.

The user explicitly approved applying `db/migrations/011_file_trash.sql`, SHA256 `07cd8fc22b31eacc7c9c74a4c97915e539ca339b6cdde1116788493fdaf9e01b`, to the current local Compose database, after disclosure of temporary table-lock risk and confirmation that no file content would be deleted. This approval separately authorized the live migration excluded from the earlier implementation scope.

The existing `migrate` runner was invoked against the fixed target `127.0.0.1:5432/aira_nexus` with5-second lock and30-second statement timeouts; it first verified the exact approved file hash and refused any pending migration other than011. Only011 was pending and applied. Its recorded schema-migrations hash matched the approved hash; the new column was present and both active/trash listing queries compiled successfully.

Post-application verification: running API `/health/ready` returned `{"status":"ready"}`; actual read-only ready/active/trash queries succeeded, retaining all seven ready files as active and no files in trash. No application restart, file deletion, upload, trash/restore mutation or publication was performed. Authenticated browser interaction was not exercised; the existing error display needs a file-list reload.
