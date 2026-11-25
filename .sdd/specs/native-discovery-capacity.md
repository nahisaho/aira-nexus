---
feature: native-discovery-capacity
tier: T2
approval: human
---
# Bounded command-definition discovery capacity
Goal: qualify the existing file-operation implementation without excluding installed execution definitions or discarding evidence.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-NDC-001 | When command-definition discovery visits up to16384 distinct directories, the tool shall retain complete package-resolution and command-definition provenance and allow genuine assertion Red, Green and verification; crossing the old4096-directory boundary alone shall not reject valid work. | TEST-NDC-001 |
| REQ-NDC-002 | If discovery needs more than16384 directories, the tool shall explicitly refuse before executing the test or appending evidence, preserving all prior ledger bytes and all other discovery limits. | TEST-NDC-002 |
## Design
Change only the existing per-closure directory ceiling and its diagnostic from4096 to16384; retain fail-closed byte, token, inspection, candidate and directory-entry limits.
Retain installed dependency traversal, full definition hashes and package-resolution metadata. Do not ignore node_modules, narrow required tests, disable planning or alter historical evidence.
Use disposable generated directory trees for boundary/provenance regression tests. Retarget the existing directory-exhaustion control in `scripts/sdd.test.mjs` to17000 paths and the16384 diagnostic; preserve its other cases.
## PASS conditions and counterexamples
`REQ-NDC-001`: a5000-directory installed dependency fixture records assertion Red then Green; a package-resolution edit invalidates its gate and restoring it recovers the gate. Reject truncation, ignored package metadata and passing-test Red.
`REQ-NDC-002`: a17000-directory fixture refuses explicitly without changing an existing ledger or executing its test. Reject silent truncation, successful evidence and changes to other limits.
Verification: TEST-NDC-001/002 and TEST-R34-CLOSURE-001/002/003/004 (including unchanged token/inspection/byte refusals), actual file-operation native Red/Green, task verification and full project gate.
## Feasibility spike
2026-11-16: current node_modules contains4401 directories and958 package manifests. The unchanged native Red command refuses its4096-directory budget before running TEST-FTB-001.
An isolated identical tool copy with only the16384 ceiling runs that actual passing regression and correctly rejects Red because the test passes; no ledger event is appended.
## Assumptions / risks
The larger finite ceiling permits more CPU/memory use but grants no application permission; other independent limits still apply. Human approval is required for this resource-policy expansion.
No existing user file is deleted, no live purge is executed, no service is restarted, and no release or publication is authorized.
