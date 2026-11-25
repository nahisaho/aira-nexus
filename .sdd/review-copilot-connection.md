# Copilot connection review evidence

Scope: the first foundation-two unit, connection settings and owner-bound
GitHub device authentication. Application implementation, native Red/Green,
live OAuth authorization and Copilot model access are not complete.

Pre-review machine checks: the native specification parser accepts the four
requirements. SDK 1.0.31 starts, creates an offline session, exposes an empty
offered tool list, refuses direct `bash` invocation with a failure result,
aborts, disconnects and stops. All runtime checks use network-disabled,
resource-capped containers and no real credentials.

Retained feasibility failures are not native TDD evidence: the packaged SDK
rejects a bare wildcard and returns unavailable-tool failure envelopes rather
than RPC rejections. The final script uses source-specific `ToolSet` exclusions
and verifies the documented failure result plus the unavailable-tool error.
Only `workingDirectory`, not the unsupported `cwd` option, is used.

| ID | Severity | Evidence | State |
| --- | --- | --- | --- |
| CON-D001 | medium | Spec design: approval now atomically rechecks owner generation/lease and replaces a single connection with fresh record UUID/nonce; disconnect uses the same serialization. | Fixed |
| CON-D002 | medium | Spec design: each result clears its claimed lease and sets a fenced next-poll deadline; crashed leases expire before reclaim. Holding the old lease end after successful release is unnecessary because the upstream call has completed and the new interval starts at completion. | Fixed |
| CON-D003 | low | Spec API: the 30-second start cooldown is per owner, poll eligibility uses its own interval/lease maximum, and Retry-After is ceiling seconds remaining for that limit. | Fixed |
| CON-D004 | medium | Spec state machine: disconnect cancels/fences unfinished attempts, stale completions cannot write, and expiry wins over late approval. | Fixed |
| CON-D005 | medium | Spec recovery: starting has a 15-second failure deadline; every owner operation reconciles overdue reservations and clears secrets. | Fixed |
| CON-D006 | low | Spec UI lifecycle: identity-keyed UI state is discarded; the server attempt remains bound to its original owner and resumable until terminal. | Fixed |

Initial Sonnet 5.5 reviews verified all three manifest hashes in each risk axis.
The privacy reviewer read the connection design; the state reviewer read the
design but explicitly did not reread SDK source/log contents or official docs.
The bounded delta review verified five final hashes and found no remaining
issues in the six fixes or newly appended notebook entry. Its scope excluded
unchanged SDK contents, historic notebook prose and independent reruns of
parser/prose checks. No live OAuth or implementation result was inferred.

The notebook's original prefix is unchanged. The post-entry draft and final
are byte-identical; GiNZA returned zero findings in both runs, its invariant
gate passed, and structural lint returned zero findings. Japanese prose
optimization completed without optional rewrites.

At the end of the design review, human approval was pending and implementation
had not started. The following implementation record supersedes that status,
not the historical evidence above.

## Approved first-unit implementation

The user explicitly approved the locked specification at
`c6cf8642d21b196989b6ea11d80d27b7ef6dc222d612fcbc84c83ec3efb08f10`;
the native approval names `nahisaho`. The approved specification is unchanged.
Five native assertion Reds and Greens cover TEST-CON-001 through TEST-CON-005.
Stronger protocol, conservative token-expiry and known-revocation assertions
also have fresh native assertion Red/Green evidence. The first timer-based
UI retest timed out because of its fixture; that retained failure is not
counted as assertion-Red proof. Corrected, final UI tests fail by the stale-code
assertion before the fix and pass afterward.

Four parallel Claude Sonnet 5.5 implementation reviews verified all used
manifest hashes. Trust and state reviewers found no concrete bugs. Contract
and test-adequacy findings were resolved as follows.

| ID | Severity | Evidence | State |
| --- | --- | --- | --- |
| CON-I001 | low | README GitHub setup explicitly requires migration and API to use the same DATABASE_URL and migration 002 to complete before restart. | Fixed |
| CON-I002 | low | An approved poll now clears pending data before refreshing status; a failed refresh cannot show an obsolete code or restart terminal polling. Final TEST-CON-001 reproduces the original assertion failure and checks the fix with actual timer-driven polling. | Fixed |
| CON-I003 | medium, tests | Additional characterization tests inspect actual connection UUID/ciphertext replacement, retain the previous usable connection until approval, and reject old ciphertext under the replacement record. The original ciphertext/plaintext assertion tested encryption at rest, not replacement by itself. | Fixed |
| CON-I004 | medium, tests | Characterization tests query NULL device/user codes and leases after cancel, disconnect, deny, expiry, approval and supersession; disconnect additionally checks NULL token/expiry/record. These are supplementary controls, not additional native TDD claims. | Fixed |
| CON-I005 | medium, tests | A held device-start response is released after disconnect; the test also rejects a simultaneous start, checks cancellation/cleared secrets and denies credential resolution. A separate leased approval at exact code expiry is discarded. | Fixed |
| CON-I006 | medium, tests | TEST-CON-001 now drives polling timers, aborts an in-flight poll on identity change, releases the stale approved result, advances timers and verifies no more network calls or previous-user modal. Existing close assertions check actual abort/focus restoration. | Fixed |
| CON-I007 | info | The claimed upstream-503 case is inapplicable: provider/protocol failures are sanitized 502; 503 covers disabled configuration, unavailable persisted state and decryption. Generic administrator guidance remains appropriate. | Rejected |

The additional recovery tests characterize already implemented properties;
they are not misrepresented as new counterexample-first/native Red evidence.
Current whole-app tests pass: 26 tests in nine files. TypeScript, ESLint,
production build, formatting and native diagnostics pass. The build retains
the existing dependency-annotation and chunk-size warnings.

Mutation evidence is isolated from live source and real services: twelve
original mutations plus approved-refresh and terminal-device-retention checks
are bounded, restored byte-for-byte, and checked against valid controls.
The DOM-assertion parser initially missed ANSI-coloured matcher errors; that
harness failure is retained, not counted as a surviving production mutation.
See session artifacts `connection-mutations-original-results.json`,
`connection-mutations-delta.log` and the mutation-copy controls.

No live OAuth, Copilot entitlement/model call, production Azure, actual .env
edit, running database migration or service restart was performed. Revocation
has an owner-serialized conditional invalidation hook; upstream detection is
for the later SDK/chat integration. Review deltas, final task receipts and
the full gate are recorded only after their actual execution.
