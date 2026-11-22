# Conversion Jobs tab design review

spec: sha256:1755631c61b97455a9714c9f1f19f4cc3d0aa7e79b053ceb752dcd880bc13617
verdict: pass
open: 0

Independent reviewer: Claude Sonnet 5.5, agent0f0d25d0-878b-4be8-89dd-fae224e71fdb.
Scope: Jobs-tab requirements, acknowledged request/state/action contract and the
reviewed availability delta; not future source implementation or browser proof.
The reviewer read the original and revised UI contract; final r3/r4 passes found
no new findings in the DCV/CJU contract scopes. The UI hash remained unchanged.

| ID       | Severity     | Path                               | State | Resolution                                                                                                    |
| -------- | ------------ | ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| DCV-D204 | Non-Blocking | .sdd/specs/conversion-job-ui.md:11 | Fixed | Trashed/purged output shows localized unavailable status without an open action or changing historic success. |

Final immutable manifest:
`phase2-docling-spike/design-r4/manifest.json`
sha256:1b8eb3775f7c3fbb509e6e313fd6a03c8215d2a12e398fcfa4778b43c5df710d.
Full source/browser checks and exact native task verification remain required.
Upstream runtime/conversion human approvals remain prerequisites; this design
review does not enable workers or authorize live documents, migration or release.

## Implementation review — 2026-11-18

The initial implementation delta is retained in `.sdd/ui-work-evidence/review.diff`.
Four independent Claude Sonnet 5.5 reviewers covered trust, state/concurrency,
contract/accessibility and regression adequacy after 29 targeted tests, 13 Native
Greens and TypeScript/ESLint diagnostics passed. Trust and state reviewers found
no defects. Two subsequent independent delta-review rounds found no remaining
findings after the fixes below. This verdict covers implementation review, not
task receipts, the full-project gate or browser replay.

| ID                  | Severity | Path                                          | State    | Resolution                                                                                                                                                                                                                                                              |
| ------------------- | -------- | --------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CJU-A1 / WRITE-DROP | Medium   | src/client/components/conversion-jobs.tsx:115 | Fixed    | Background polls are silent and preemptible; explicit actions keep stable controls. `TEST-CJU-014` recorded an actual Native Red and Green. Independent delta reviewers confirmed the fix.                                                                              |
| CJU-A2              | Low      | src/client/components/conversion-jobs.tsx:314 | Fixed    | Acknowledged cancellation restores focus to its row. `TEST-CJU-014` and both delta reviewers confirmed the positive case; the unsuccessful-write edge case is tracked below.                                                                                            |
| WRITE-STALE         | Medium   | tests/conversion-jobs.test.tsx                | Fixed    | `TEST-CJU-015` covers cancel/retry acknowledgments and 401 across owner, project, epoch and activity changes; the isolated missing-commit-fence mutation failed, restoration passed Native Green.                                                                       |
| POLL-STOP           | Medium   | src/client/components/conversion-jobs.tsx:189 | Fixed    | Explicit reload after a visible polling failure is the conservative retry policy. `TEST-CJU-016` pins retention and recovery; an automatic-posterror-poll mutation failed with seven requests instead of two, then restoration passed Native Green.                     |
| PAGE-RACE           | Low      | tests/conversion-jobs.test.tsx                | Rejected | No concrete data-loss path was identified: pagination merges acknowledged pages atomically, and reads cannot overlap. `TEST-CJU-009` checks page retention; `TEST-CJU-014` additionally checks discarding a preempted poll.                                             |
| CJU-A2b / CJU-F1    | Low      | src/client/components/conversion-jobs.tsx:325 | Fixed    | Failed/discarded/no-op writes return false and clear pending focus intent. The extended `TEST-CJU-014` actually failed on the old implementation (`tdd red --retest`) and passed after the fix; both reviewers confirmed the fix in two consecutive clean delta rounds. |
| CJU-DOC1            | Medium   | docs/conversion-jobs.md:21                    | Fixed    | The scoped English user guide now explains temporary disabling during uploads/file actions/requests and when Reconvert appears. Structural lint and formatting passed again; independent Sonnet documentation re-review returned CLEAN.                                 |

### Actual implementation evidence

Evidence directory: `.sdd/ui-work-evidence/`. All tests use synthetic inputs.

| Check                                         | Actual result                                                                                                                                                                                                                                              | Retained evidence                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Original five Native and two integration Reds | All seven still failed by assertion before implementation; original test bodies were unchanged                                                                                                                                                             | `retained-reds-current.json`, `pre-implementation-native-audit.json`                                             |
| Jobs Native TDD                               | All sixteen current tests passed Green/refactor; shared test-oracle changes were retraced with genuine Reds, not hash-only adoption                                                                                                                        | `final-jobs-native-refactor.stdout`, `focus-failure-native-{red,green}.stdout`, `review-fix-native-green.stdout` |
| Affected browser-side regression files        | 73 passed, zero failed                                                                                                                                                                                                                                     | `final-source-ui-tests.json`                                                                                     |
| Required TypeScript/ESLint diagnostics        | PASS, no diagnostics                                                                                                                                                                                                                                       | `final-source-diagnostics.stdout`                                                                                |
| Application build                             | `npm run build` passed; Rollup reported non-fatal Zod comment, JSON-import-attribute consistency and large-chunk warnings                                                                                                                                  | `production-build.{stdout,stderr}`                                                                               |
| Changed-file formatting                       | Source, tests and implementation plan passed Prettier; the review ledger was also formatted and checked                                                                                                                                                    | `changed-format.stdout`, `review-format.stdout` and session tool results                                         |
| Further existing App-fixture consumers        | Seventeen unchanged assertion bodies passed actual Native refactor after shared-fixture invalidation; retained oracle warnings are not presented as new Red evidence                                                                                       | `shared-app-oracle-refresh.stdout`, `dialogs-shared-app-oracle-refresh.stdout`                                   |
| Scoped user guide                             | English reader instructions passed Prettier and structural lint with zero findings; independent Sonnet round two was clean after correcting the temporary-disabled-action explanation                                                                      | `user-guide-format.stdout`, `user-guide-structure.json` and session tool results                                 |
| Bounded mutations                             | Cross-project response, polling interval, optimistic cancellation, retry idempotency, unavailable artifact action and exact size boundary each produced a failing regression; every mutation was restored byte-for-byte before the restored control passed | `mutation-*.json`, `restored-all-ui-tests.json`, `mutation-baseline.json`                                        |
| Additional state mutations                    | Missing stale-write commit fence and unintended automatic recovery polling each produced a genuine Native assertion Red, then restored Green                                                                                                               | `mutation-current-red-cju-{015,016}.stdout`, `review-fix-native-green.stdout`                                    |
| Review rounds                                 | Initial four risk axes; follow-up found and fixed unsuccessful-write focus; two final independent two-axis rounds were clean                                                                                                                               | `review.diff`, `fix.diff`, `focus-fix.diff` and session tool results                                             |
| Resource handling                             | Full-ledger commands ran serially after MemAvailable ≥8 GiB checks, using the approved 8 GiB Node allowance; each command retained actual resource outcomes                                                                                                | `*.resources.json`, `initial-plan-resources.json`                                                                |

The approved specification hash remains
`1755631c61b97455a9714c9f1f19f4cc3d0aa7e79b053ceb752dcd880bc13617`.
Updating this implementation-review ledger invalidated its old review-file-bound
design approval; the unchanged auto-approved design was explicitly re-locked
without asserting that implementation review was clean at that time
(`unchanged-design-approval.stdout`). No specification or frozen tool/config
content was changed.

No production activation, real-document run, browser replay, publication or
full-project gate is implied by these implementation checks.

## Final verification boundary

The actual Jobs task verification passed and its successful receipt was adopted:
`.sdd/plan-evidence/26a5524077018a8de8c948fffe83f4926dc3c8e7fc512aa76a4cccd466f03a24/b20b2a277e445dc0e0805530f175e29bc493bef1b661b4aefcdd5c8b2d8b242a.json`.
All fifteen affected task verifications passed after legitimate requalification.
The final actual root `plan check --json` passed with all 22 tasks observed complete.

The actual root `gate --changed --json` returned **INCOMPLETE** (exit 2):
`.consulting/research-workbench/analysis-brief.md: planning ownership is unresolved`.
That unrelated artifact was not edited, reassigned or ignored to bypass the gate.
Work stopped at this scope boundary; the full gate was not run afterward.
Implementation-review success and the Jobs receipt do not override this aggregate
blocker. Browser replay and production activation remain separate.

Exact evidence: `jobs-ui-task-verification.stdout`,
`final-plan-consistency.stdout`, `changed-root-gate.stdout` and their
`.resources.json` companions in `.sdd/ui-work-evidence/`.
