# Docling runtime design review
spec: sha256:001ddb7391eed94ea331130f644c32621a2aca56817ee4ac8e87f742887699ee
verdict: pass
open: 0

Independent reviewer: Claude Sonnet 5.5, agent888732fe-7379-4c42-b24c-f6b6626976ae.
Scope: runtime contract, runtime/conversion interlock and isolated feasibility;
not a completed production implementation, security audit or operational approval.
Two consecutive clean delta passes covered immutable rounds r2 and r3.

| ID | Severity | Path | State | Resolution |
| --- | --- | --- | --- | --- |
| DRT-D101 | Non-Blocking | .sdd/specs/docling-runtime.md:26 | Fixed | Actual six-format read-only-input/model and strict-IPC replay; exact argv/inspection receipts preserved. |
| DRT-D102 | Non-Blocking | .sdd/specs/docling-runtime.md:14 | Fixed | One absolute15s stop/wait/inspect/remove deadline, verified in actual lifecycle replay. |
| DRT-D103 | Non-Blocking | .sdd/specs/docling-runtime.md:10 | Fixed | Actual docling-slim distribution pinned; image and model-file SHA256 validation required. |

Final common manifest:
`phase2-docling-spike/design-r4/manifest.json`
sha256:1b8eb3775f7c3fbb509e6e313fd6a03c8215d2a12e398fcfa4778b43c5df710d.
The r4 runtime/evidence are unchanged; its sole conversion delta makes the
guard-clear/new-request transaction explicit, as reviewed by the state reviewer.
Evidence and finding ledger are in the current Copilot session files directory.
Controlled exit2, model-hash readiness and job/fence-labelled orphan recovery
still need production tests; synthetic OCR is not a general accuracy guarantee.
Human approval of the exact spec is still required; no live activation implied.

## Implementation delta review
The design record above is historical. Exact-spec human approval is recorded in
`.sdd/approvals.json`; it does not authorize live activation.
Independent Claude Sonnet 5.5 reviewers:
`dfeacfff-bf1d-4242-be0a-3ebb85867679` (lifecycle/isolation) and
`aa4bf7b5-bf29-414a-90cf-cd0b1a52afef` (parser/IPC/provenance).
Both axes finished two consecutive clean delta rounds; the final unchanged
parser round relied on the prior fix review, not another full-file inspection.

| ID | Severity | Path | State | Resolution |
| --- | --- | --- | --- | --- |
| DRT-I101 | Medium | src/server/conversion/runtime.ts:686 | Fixed | Forward abort into create; a withheld-response create regression proves exact-labelled recovery/removal without resetting the shared cleanup deadline. |
| DRT-I201 | Critical | src/server/conversion/parser.py:18 | Fixed | Read the mounted sibling manifest before evaluating a depth-bounded checkout fallback; execute the parser with `/app/parser.py` identity in the regression. |
| DRT-I202 | High | src/server/conversion/parser.py:88 | Fixed | Pass the explicit raw PDF handle; a strict typed-handle harness rejects the helper object. The initial reviewer did not reproduce against installed real pypdfium2. |

Final SHA256: runtime `cb8b332116c53ae3a8f74cfb9e6f538a2ce549a5034aa0811ceca741e35337a7`;
parser `6fdb7b9e80977be091eb6334f9b22bfb50f7fb8287caef779756398dbe1e86ab`;
protocol `753f589df7bd63460c3a5b1ac5afc60af95e93fee14e421b9af2f608f0326414`;
tests `6e88bae76a0c98892c2a7af1ee0bb697136e1f2f19ef5e3f03a80d0a053aeb39`.
Current Native Red/Green evidence covers all six tests, including fresh genuine
assertion Reds after shared-manifest/harness changes and restored failing-runtime
controls. Scoped ESLint/format, all six tests and full TypeScript passed.
Runtime task verification PASS:
`.sdd/plan-evidence/45f3c36ea2b696e21280e653c71599b9dfe5c6239988a74ecea373956f8c4a85/a5e2a3627c5690d8c49e65fa588dd63affa3080aada5e52d226dbf8902b3e41d.json`.
Logs are retained under session `phase2-docling-spike/native-runtime-*`.
This is not a full-project gate, production Docker replay, backend integration,
hostile-host attestation or operational approval. Project diagnostics still
report unused variables in unimplemented sibling stubs; TypeScript is clean.
