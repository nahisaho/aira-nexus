# Durable document conversion design review
spec: sha256:4ef6c4bf978adf2a123f1b70556829e5f0f2059e1ccb6edc11cfa9e92e9dcb0e
verdict: pass
open: 0

Independent reviewer: Claude Sonnet 5.5, agent0f0d25d0-878b-4be8-89dd-fae224e71fdb.
Scope: conversion/UI contracts, research-services row014 delta and primitive SQL
evidence; not completed production integration or concurrency qualification.
Two consecutive clean delta passes covered immutable rounds r3 and r4.

| ID | Severity | Path | State | Resolution |
| --- | --- | --- | --- | --- |
| DCV-D201 | Blocking | .sdd/specs/document-conversion.md:23 | Fixed | Typed outcome and worker settlement adapter atomically write canonical job state plus request-side reason/artifacts. |
| DCV-D202 | Non-Blocking | .sdd/specs/document-conversion.md:19 | Fixed | Bounded oldest-owner-head admission excludes capped owners and rechecks capacity. |
| DCV-D203 | Non-Blocking | .sdd/specs/document-conversion.md:13 | Fixed | Both reservations unexpired; quota rechecked without counting the pair twice. |
| DCV-D204 | Non-Blocking | .sdd/specs/document-conversion.md:24 | Fixed | Keep historical IDs/success but suppress trashed/missing links via owner-scoped availability. |
| DCV-D205 | Non-Blocking | .sdd/specs/document-conversion.md:20 | Fixed | Derived active flag/partial unique index; guard-clear and fresh insert share one job-locked transaction without changing linked history. |

Final immutable manifest:
`phase2-docling-spike/design-r4/manifest.json`
sha256:1b8eb3775f7c3fbb509e6e313fd6a03c8215d2a12e398fcfa4778b43c5df710d.
Evidence and complete finding ledger are in the current Copilot session files.
The reviewer did not re-read unchanged evidence in the final stability pass.
Production adapter, Blob/DB integration, state-cell tests, Native evidence and
fresh full gate remain required; the earlier19-task gate predates these drafts.
Human approval and a current expanded task plan are required before implementation.

## Implementation delta review
The design status above is historical; exact-spec human approval is recorded in
`.sdd/approvals.json`. No live configuration, schema or storage was activated.
Independent Claude Sonnet 5.5 reviewers:
`e3ddd01d-d609-4ac0-9895-32af4bc2ff84` (SQL/state/concurrency) and
`3869cb3a-71c4-4742-a508-a725d5534cd1` (API/config/worker).
No implementation findings remain open. Supplemental rounds completed the
initially omitted API/config and SQL-fault test review; unchanged production
delta was clean. Reviewers read code/tests and verified manifest hashes, not
the actual test executions. Parent execution results are recorded separately.

Frozen 15-file SHA256 inventories: session
`phase2-docling-spike/backend-review-r1.sha256` and
`phase2-docling-spike/backend-review-r2.sha256`; r2 changes only conversion tests.
The original approved spec and runtime implementation are unchanged.
Native evidence: seven current DCV cases pass; DCV004 has a new genuine
identity-fence assertion Red/Green. Six unchanged case bodies were revalidated
with Refactor after additional independent test cases were added, retaining
their earlier genuine Reds/Greens rather than claiming new counterexamples.
All26 focused conversion/job/file tests pass with disposable PostgreSQL/Azurite,
including insert/publication SQL rollback faults, failed second-Blob staging,
cancel-before-publication, unconfirmed cleanup, heartbeat-stop settlement,
oldest-owner heads, source SHA changes and concurrent upload/publication.
Source-fence, owner-cap and premature-settlement mutants were detected by
assertions and restored; restored source hashes and passing controls are logged.
Scoped ESLint/format and full TypeScript pass. Whole diagnostics still fail
two unimplemented UI stubs. The ten affected backend prerequisites and the
backend task passed actual verification, with receipts adopted.
Backend receipt:
`.sdd/plan-evidence/e7ffc474c59366ebda4eaee0ec714b835580df338e450b57e56adfc843226f36/cdb46d9be2d08b0c22e1afc371752149c108741e4169f8dc50ecc16edebd6b8e.json`.
Actual production-launcher browser replay, remaining affected UI-neighbor
requalification and the full gate are pending.

## Provider/content ETag repair — in progress

The earlier implementation review is historical. The isolated actual-converter
replay subsequently reproduced `source_changed` for unchanged Blob bytes.
Both approved backend/runtime specs retain their exact approved hashes.

| ID | Severity | Path | State | Resolution |
| --- | --- | --- | --- | --- |
| ETAG-001 | High | src/server/conversion/worker.ts:62 | Fixed | Runtime identity now uses quoted stored SHA256 while raw provider If-Match and SQL snapshots remain unchanged. Genuine Native Red/Green, three restored assertion-detected mutants, 32 focused passing tests, two clean independent review rounds, actual offline DOCX/PDF browser replay and fresh successful backend/UI receipts are retained under `.sdd/ui-work-evidence/etag-repair/`. |
| ETAG-002 | Informational | src/server/conversion/runtime.ts:378 | Resolved | Two independent Sonnet 5.5 proposal reviews permit the worker-only repair: preserve raw provider ETag for repository snapshots and Blob If-Match, retain stored SHA256/size validation and publication fences, and explicitly distinguish the runtime content identity. Neither review is new human approval. |

`TEST-DCV-008` extends the existing real-Blob worker integration with actual
runtime input validation, changed provider-version and equal-length changed-byte
controls. Its validation-only aborted runtime does not replace the required
actual isolated-converter browser replay.

The unrelated changed-gate ownership error and previous full-gate TMPDIR failures
remain unresolved. No approved spec, frozen tool/config, runtime, parser,
repository or Blob conditional-read implementation has been changed.

### Repair implementation review, round 1

The worker-only repair is now applied. Fresh current planning consistency passed
before the production edit. `TEST-DCV-008` recorded a genuine assertion Red and
Green; the unchanged seven earlier assertion bodies were verified byte-identical
with TypeScript AST extraction and revalidated after the shared import preamble
changed. All 32 focused conversion/job/file/runtime tests, required diagnostics,
restored conversion tests and owned-file formatting passed. Three isolated
worker mutants failed by assertion and were restored byte-for-byte; the test and
human approval record remain unchanged since the fixed-source inventory.

Independent Claude Sonnet 5.5 security/contract and correctness/test-adequacy
reviews returned no findings. The first security reviewer explicitly did not
re-read unchanged repository guards; a bounded guard/stability follow-up is
required before review closure. The aborted validator test is not parser/browser
proof. Actual repaired browser replay and fresh affected-task receipts are still
pending; ETAG-001 remains open until those qualifications are resolved.

The new worker annotation creates an implementation-change warning against the
historical human code baseline. Neither the warning nor these AI reviews record
new human approval. Approved specifications and `.sdd/approvals.json` are unchanged.

### Repair stability review and actual converter replay

The second independent Claude Sonnet 5.5 round found no new repair defects.
The security reviewer inspected repository lines 112–176 and 441–625, including
source snapshots, owner/project row locks, lease/fence/cancel checks, both
reservations, quota and transactional paired publication. The test reviewer
statically audited all three actual mutation assertion failures and the restored
13/13 conversion results; that is artifact review, not independent test execution.
Its ledger lookup omitted the hyphen in ETAG-001, so the complete open-finding
closure relies on the security follow-up and the execution evidence here.

Actual isolated browser replay now passed all ten checks using unchanged
production `DoclingRuntime`, the pinned cached image and all 74 cached models:
DOCX upload without navigation, queued cancellation/retry, real conversion,
verified Markdown/JSON opening, one central Jobs tab, actual running PDF
cancellation and retry, and real PDF conversion/viewing. No browser errors,
external requests or cleanup errors occurred. The private model copy and every
namespaced service/converter were removed; original cache permissions/content
checks passed. This is actual parser/browser execution, not the aborted validator.
Evidence: `.sdd/ui-work-evidence/etag-repair/replay/browser-replay.json`,
`replay.resources.json`, screenshots and `replay-preflight.json`.

Fresh affected-task verification receipts remain pending. The historical full
gate failure, changed-gate ownership blocker and human implementation-change
warning remain explicit and are not converted into aggregate approval.

### Repair qualification closure

Both actual affected-task verifications passed and their successful receipts
were adopted; old receipts remain historical:

- Backend: `.sdd/plan-evidence/e7ffc474c59366ebda4eaee0ec714b835580df338e450b57e56adfc843226f36/9a67635aad42db2641053067ee8d2a1241e30dc48186b24b0b31e9c072b676bf.json`.
- Jobs UI: `.sdd/plan-evidence/26a5524077018a8de8c948fffe83f4926dc3c8e7fc512aa76a4cccd466f03a24/7d0b375ced6ee6d167e0b0d5e4290219cfce280d295ca6e2d9ccca89ed8ec194.json`.

The backend receipt includes all eight current Native cases; the UI receipt
includes all sixteen. ETAG-001 is closed for this bounded repair, not for
aggregate release qualification. No security contract, approved spec, frozen
tool/config, human approval record, runtime, parser, repository or Blob-store
implementation was changed. The new worker human code-baseline warning still
requires appropriate human review before any later approval/publication claim.

The fresh actual `gate --changed` still returned INCOMPLETE/2 solely for the
unresolved consulting-file ownership. Its untouched output, measured status and
corrected text-format audit are under `etag-repair/changed-gate-current.*`.
The original changed-gate JSON remains byte-identical. No blocker was reassigned,
excluded or otherwise bypassed.
