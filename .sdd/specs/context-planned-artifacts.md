---
feature: context-planned-artifacts
tier: T2
approval: human
---
# Context for planned artifacts
Goal: permit complete reading of existing context while identifying genuinely future planned artifacts. Non-goals: placeholders, approval or verification evidence, weaker gates, release approval.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-CTXPLAN-001 | When a selected planned artifact is absent and every owner has authored status not-started, in-progress or blocked, a null receipt and no task evidence directory, and the path is not a spec-declared artifact or explicit file selector, context shall list its canonical path and all owner task IDs as planned-missing and shall emit all selected specifications and existing artifacts. | TEST-CTXPLAN-001 |
| REQ-CTXPLAN-002 | If an absent artifact is required by a specification, directly selected, or owned by any task with complete or invalid status, a receipt reference, or a task evidence directory, context shall refuse without emitting file bodies. | TEST-CTXPLAN-002 |
| REQ-CTXPLAN-003 | If a planned path is outside the root, has an escaping or dangling symlink, a non-directory ancestor, or an existing non-regular file, context shall refuse without emitting file bodies. | TEST-CTXPLAN-003 |
| REQ-CTXPLAN-004 | When context emits planned-missing artifacts, JSON and text output shall each list every missing path and owner deterministically and state that the paths are not yet present; if either requested format's full rendered UTF-8 output exceeds its byte budget, context shall refuse without emitting file bodies or truncating the listing. | TEST-CTXPLAN-004 |
| REQ-CTXPLAN-005 | When a context contains planned-missing artifacts, planning consistency, verification, gates and approval requirements shall remain unchanged, context shall not count as evidence, and changed tool identity shall retain existing receipt invalidation behavior. | TEST-CTXPLAN-005 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-CTXPLAN-001` | Artifacts with all eligible owners, including mixed eligible statuses, are listed with all owners and all existing context is emitted. | Silently omitting a planned path or an existing artifact fails. | TEST-CTXPLAN-001 | Pending |
| `REQ-CTXPLAN-002` | Required, directly selected including alias selectors, complete-owned, unknown-status, receipt-owned and history-owned missing paths refuse. | One eligible shared owner must not hide a complete owner or evidence directory. | TEST-CTXPLAN-002 | Pending |
| `REQ-CTXPLAN-003` | Unsafe paths, directory targets and non-directory ancestors refuse. | An outside or dangling symlink followed by a missing suffix must not be accepted. | TEST-CTXPLAN-003 | Isolated path-resolution spike passed; regression pending. |
| `REQ-CTXPLAN-004` | Text and JSON report all missing paths and owners; exact byte limits apply to the entire result. | A missing path hidden by truncation, budget overflow, or PASS-shaped wording fails. | TEST-CTXPLAN-004 | Pending |
| `REQ-CTXPLAN-005` | Fixture gate still refuses incomplete work, context records no validation evidence, and old receipts remain stale after a tool identity change. | A successful context must not produce a task receipt or permit a pending full gate. | TEST-CTXPLAN-005 | Pending |
Risk stages: contract and integration are covered by explicit inventories and existing gates; inputs and execution by path/refusal tests; verdict and history by receipt and gate controls. Oracle: the requirements and the existing documented context refusal and gate contracts.
## Design
Extend the read-only context renderer after validated plan closure; canonicalize plan and spec artifact paths using existing in-root planning rules, merge owners only for identical canonical paths without folding distinct paths, and check all owners. Direct file selectors retain existing literal, non-glob semantics, including aliases; a missing selector or directory refuses before planned-path handling.
Policy: absent plus only not-started, in-progress or blocked owners, each with null receipt and no `.sdd/plan-evidence/<sha256(task-id)>` directory entry, is planned-missing; direct selector, spec-required path, complete or invalid status, receipt or evidence entry, unsafe path, or any unknown condition is refusal. Existing files are read completely; no placeholder files are created.
Retain legacy no-planning behavior, strict selectors, existing budget checks, and all gate/receipt logic. Update context-consuming skill instructions so planned-missing is explicit, never equivalent to implementation or evidence.
## Assumptions / risks
Plan claims and an absent evidence directory cannot prove a file or deleted history never existed; the listing is not history or verification. Shared owners, invalid statuses and existing evidence are checked by TEST-CTXPLAN-002.
The isolated real-runtime spike accepted a future in-root path and rejected traversal, external and dangling symlinks, and a non-directory ancestor; TEST-CTXPLAN-003 must verify command-level behavior. The filesystem is assumed not hostile or concurrently modified; race-free hostile-host attestation is not claimed. Tool files are locally Git-excluded; distribution remains unresolved. Changed tool identity invalidates receipts and requires fresh verification.
