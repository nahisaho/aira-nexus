---
feature: native-plan-replanning
tier: T2
approval: human
---
# Pending plan readiness
Current-behaviour observation: only the deferred row describes the existing tool; the active rows propose a separately approved change.
Goal: allow implementation planning after genuine replanning without claiming completion. Non-goals: application changes, history reset, state-precedence changes, weaker gates, live operations.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-NPR-001 | When a historically verified task is replanned with current known inputs, the existing CLI shall reject consistency because the old receipt definition differs. (deferred) [src: .github/skills/lean-sdd-tdd/scripts/implementation-plan-cli.mjs:133, conf: high] | — |
| REQ-NPR-002 | When plan check finds a historically attempted task explicitly not-started, in-progress or blocked, it shall permit pending consistency only when all declared bindings and input/artifact hashes are current and known, receipt/log history is valid, the authored receipt names its latest head, and native inspection has no input errors or unclassified errors; explicitly classified verification deficiencies may remain pending. | TEST-NPR-002 |
| REQ-NPR-003 | If a historically attempted stale task claims complete, has stale declared bindings, unknown/missing inputs, bad history/logs, a wrong/missing head pointer, or native input/unclassified errors, then plan check shall retain its refusal. (test-only) | TEST-NPR-003 |
| REQ-NPR-004 | When a replanned task is verified, the tool shall execute the current real checks, retain failed attempts and original receipt bytes, and refuse the full gate until the current successful receipt is adopted; planning acceptance shall not change derived task states or verification results. | TEST-NPR-004 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-NPR-001` | Replanned valid pending inputs still fail the unmodified CLI/evaluator. | An unrelated load failure is not evidence of the cycle. | Existing state tests and actual marker-check spike | plan-replanning-spike-v1.json: eight observed checks, no tool edits. |
| `REQ-NPR-002` | Pending own/transitive replanning passes consistency while stale states and failed full gate remain visible; a new TEST with explicitly classified missing Green remains pending, not complete. | Unknown TEST bindings, approvals, invalid native chains, unclassified adapter failures or unclassified synthesized coverage errors must not be mistaken for missing Green. | TEST-NPR-002; exhaustive isolated policy table and real-evaluator controls | Proposed; actual Native adapter Red/Green pending. |
| `REQ-NPR-003` | Each real-evaluator invalid control retains its exact exit/state/input reason, including corruption in an older receipt/log and a stale complete claim. | Clearing a pointer, hiding history or accepting an input error is a failure. | TEST-NPR-003 characterization plus restored mutations | Existing controls pass; new focused characterization pending. |
| `REQ-NPR-004` | Actual missing-marker verification fails for that check; adopting that failed head permits only planning; adding the marker and adopting actual success enables the fixture gate, preserving original/failed receipts and their logs byte-for-byte. | Old success, authored completion, or a gate-only result cannot establish new task completion. | TEST-NPR-004; TEST-NLR-003 helper-only identity control | Actual original marker failure observed; new regression pending. |
## Design
Add a small readiness wrapper around the unchanged evidence evaluator; route only plan/check through it. Keep gate/task verification, state precedence, chain/schema/receipt/log validation and full configured scope unchanged.
Native inspection errors retain their existing exit/reason and gain a structured phase: input by default. Only evidenceStatus's explicit missing-Green, missing-Red, stale-test, stale-REQ and stale-artifact return branches mark verification; its invalid-ledger branch and all unknown branches remain input. Unknown phases and synthesized unclassified errors fail closed; no reason-string allowlist.
Decision: valid pending + current known declarations + intact adopted history + no input errors => planning-only exemption; stale complete or any failed input condition => existing refusal; all derived states and full-gate requirements remain unchanged.
Include the new module in native tool identity; extend the existing helper-only fingerprint control without changing its REQ/TEST ID. Bootstrap with real native commands in a private small-ledger workspace, then transfer only hash-matching tool bytes to the private candidate and freshly verify changed prerequisites.
## Assumptions / risks
The observed cycle is treated as a bug per investigate_and_fix_private_planner; its deferred observation is not new Green evidence. Synthetic policy-table checks and documentation fixtures are tooling feasibility only, never application completion.
Planning acceptance deliberately tolerates missing/stale verification for explicitly pending work, not bad input/approval/ledger integrity. Native phase classification and latest-head adoption are the principal risks; independent reviews and invalid/valid controls must cover both. Existing application histories, weak Reds, warnings, live settings and original native-ledger-capacity specification remain unchanged.
