# Deferred research-services intent review

## Current Docling opt-in design delta

Reviewed spec sha256:
`48aad99264f105fd1f5eedaae5b0ead8fb8a8893cfe51e5844012ed6cf85bafe`.
The existing human approval is stale for this proposed row014 policy change.
Claude Sonnet 5.5 independently reviewed the bounded delta: keep an empty
default registry, permit only explicitly enabled fixed document.convert, and
keep external AI/arbitrary execution/chat activation excluded.
Runtime and state reviewers closed their respective findings; final delta
passes found no new findings for their inspected scopes. Current design reports
are review-docling-runtime.md, review-document-conversion.md and
review-conversion-job-ui.md, with the frozen manifest hash and limitations.
Human approval, revised plan bindings and production/native validation remain
required. No live configuration, migration, worker activation or release is
authorized. The sections below retain historical evidence and qualifications;
they are not claims of completeness for these new requirements.

Claude Sonnet 5.5 reviewed the unchanged future-intent specification: no blocking findings. Every REQ remains deferred and unimplemented; this lock is not activation or readiness approval.
R-SVC-01|low|.sdd/specs/research-services.md:13|Deferred: link the previously agreed decimal 10GB quota to activation tests and final storage/retention decisions.
Activation still requires feasibility spikes, counterexample tests and applicable fresh approvals. No implementation evidence is claimed.

## Project file activation design

The proposed contract activates REQ-SVC-001 and REQ-SVC-004..009 only;
REQ-SVC-002/003 remain deferred. The user confirmed the existing Azure/Azurite,
100MB/file and10GB/project decisions, requested text/CSV/JSON/Markdown/
Python/R/PNG/SVG/PDF viewing, and accepted explicit bounded preview limits.
R-SVC-01 is addressed in the proposed decimal quota/reservation tests;
it is not implementation evidence or a production storage-retention guarantee.
Proposed approval is human because this unit introduces server-side storage
authentication configuration. No human approval is recorded yet.

Isolated feasibility passed actual Azure SDK12.33.0 streaming/conditional
commands against private disposable Azurite, real PostgreSQL quota races and
all six state-transition rows, and actual PDF.js6.5.438/PNG/inert SVG rendering
under unchanged production CSP. Syntax and strict scratch TypeScript checks
passed. Initial Azurite readiness-log wording and obsolete doc.destroy
prototype failures are excluded from passing evidence and were corrected
before the replay. Synthetic resources were cleaned; no live data was touched.
The renderer prototype is not a production bundle or resource-limit test.

Production implementation, native assertion Reds/Greens, task-plan activation,
full gate and live backup/migration/configuration consent remain pending.

| ID        | Severity | Disposition                                                                                                                                                         | State |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| FILE-D101 | medium   | Reserve the declared size; reject declaration+1 immediately; only exact actual==declared can finalize.                                                              | Fixed |
| FILE-D102 | medium   | Finalization uses DB time; expired/lost fence returns409, never success.                                                                                            | Fixed |
| FILE-D103 | low      | Stored-ETag mismatch maps to503 before headers.                                                                                                                     | Fixed |
| FILE-D104 | medium   | TEST-SVC-004 explicitly requires post-header interrupted HTTP response and valid control.                                                                           | Fixed |
| FILE-D105 | medium   | Shared-key development credentials are rejected for every host except numeric127.0.0.1/::1.                                                                         | Fixed |
| FILE-D106 | medium   | Metadata bytes checked before fetch; PNG IHDR/SVG dimensions before decode; PDF page count/finite scaled viewport/DPR/pixels before render/allocation.              | Fixed |
| FILE-D107 | medium   | Adversarial SVG script/events/foreignObject/external href/use/CSS import/url fixtures must reject with valid local-fragment/style controls.                         | Fixed |
| FILE-D108 | medium   | Explorer owns scoped metadata; stable scope/file-ID-keyed viewer owns fetch/render cleanup, unmounts inactive, and does not refetch/remount on locale/name changes. | Fixed |

These are specification/planned-oracle fixes, not production implementation
or passing regression evidence. Initial two-axis review reported no blocking
finding but these eight material ambiguities were fixed before human approval.

Design convergence: storage and viewer reviewers each completed two consecutive
clean post-fix passes at spec sha256
`3a029da20d258357df3a71ca3b7284f82a319d7b026d7348ff62aa8d0a63827c`.
The final passes were bounded hash/disposition checks, not source re-reviews.
The parent additionally checked all eight frozen artifact hashes and every
FILE-D101..108 Fixed status mechanically. Actionable Open design findings: zero.
This establishes design-review completion only; human approval and all
production implementation/validation remain pending.

## Human approval and planned regression baseline

nahisaho explicitly approved implementation of the exact research-services
specification hash above; the native human approval was recorded after that
response. This does not authorize live migration, credentials/configuration
edits or runtime activation. Dependencies were installed after the manifest
change. Prepared typed stubs and seven planned tests pass native static
diagnostics. TEST-SVC-001..007 each recorded an actual assertion Red against
the failing stubs; session files/files-red-001.log through files-red-007.log
contain the observations. No Green or working file implementation is claimed.
The JSON task graph now includes backend and viewer work; current prerequisite
verification/bindings remain stale until genuine revalidation completes.

## Backend implementation evidence

The prerequisite closure was actually reverified and native plan consistency
passed before production changes. The implementation now uses private immutable
Azure/Azurite streaming, owner-fenced PostgreSQL reservations/finalization,
strict metadata/cursors and complete client size/SHA verification.
Native TEST-SVC-001..004 have actual assertion Red/Green evidence; all four
targeted tests and native static diagnostics pass. An isolated actual Node
HTTP replay additionally passed owned original-byte/empty uploads and downloads,
short-body400, declaration-overrun413 and metadata-limit413, with failures
hidden from the ready list and no remaining reservations.
Thirteen isolated source mutations failed by assertion, with passing valid and
restored controls. Supplemental copied-only fixtures make hostile endpoints use
the correct account path and fix pagination timestamps/ties; root assertions
were unchanged. This is mutation evidence, not new native root Red evidence.
An initial malformed SQL tenant mutation failed parameter typing and is excluded;
its corrected UUID-typed bypass failed by assertion. Live source was never
mutated. Session files/files-backend-mutation-results.json and
files-http-replay-results.json retain the actual observations.
The optional Compose profile and commented configuration template validate with
docker compose config --quiet; no emulator service, live004 migration or live
configuration was activated. Backend task-receipt refresh is in progress.
The explorer/PDF implementation and final independent implementation review,
full gate and live activation consent remain outstanding.

## Explorer/viewer implementation evidence

The backend task and its prerequisite closure were successfully verified before
the UI integration. The real explorer now opens stable file-ID tabs, uploads,
lists/pages and downloads original bytes; scoped cleanup and account fences
discard old work. Bounded escaped UTF-8, PNG, inert SVG and dedicated-worker PDF
previews are implemented, including explicit uncertainty after upload interruption.
An additional escaped SVG presentation-attribute fixture recorded a genuine
assertion Red, then Green after the pre-decode guard was corrected.

The application suite passed44 tests; current native UI Greens, production build,
format checks and static diagnostics pass. Actual bundled browser replay passed29
checks, including original Unicode downloads, image pixels, PDF paint/navigation,
rename/locale/theme stability, unsafe SVG/self-origin CSS import rejection,
malformed/password/201-page/metadata-limited PDFs, corrupt-download refusal,
real-worker load and page-render stalls, close/deactivation/scope cleanup and upload.
No external document fetch or document action occurred; active native workers ended
at zero. Synthetic authentication/backend routing existed only in the browser,
never in production code or the live API.

The unchanged production CSP blocks the existing Zod eval-capability probe,
inline stylesheet evaluation while XML-parsing inert SVG, and the existing
settings dialog's injected inline style. These blocked diagnostics are not
counted as successful execution; PDF rendering added no CSP violation. Actual
packaged worker/font/CMap requests returned200. Initial wrong font/health names
and overstrict zero-diagnostic browser oracles are excluded, not passing evidence.
PDF.js6 no longer has eval code generation or a typed isEvalSupported option;
the ignored legacy option was removed rather than hidden from excess-property
checking. The supported typed PDFWorker.create API owns a new native Worker.

The current native TEST-SVC-007 oracle-retest is explicitly weak after correcting
the asynchronous rejected-promise fixture/SDK mock and strengthening worker and
timeout assertions. Its earlier pre-implementation assertion Red remains in
history; no new root assertion Red is claimed for those oracle-only corrections.
The corrected test is Green and actual browser timeout/lifetime evidence passes.
Isolated mutation results and independent implementation findings are recorded
separately. Native final task receipts/full gate are still pending; neither
source completion nor these checks authorizes live004/configuration activation.

## Implementation review fixes and current machine evidence

The immutable round1 manifest hash is
`1d1c9977222ce1d7c591f6c1a2565048b67a9ce9a4bf9037f379b54ab6007934`.
Both independent reviewers use Claude Sonnet 5.5. Fixed below means source and
regressions were corrected, not that post-fix review or the final gate passed.
Round1 and the storage follow-up were not clean convergence.

| ID          | Severity | Location                                    | Disposition                                                                                                                                                                                                                                                                                                   | State    |
| ----------- | -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FILE-I201   | low      | src/server/files/service.ts:114             | HTTP is the approved interface and checks ownership before metadata/slots. Internal calls still check ownership before reservation/blob writes; reviewer accepted this explanation.                                                                                                                           | Rejected |
| FILE-I202   | medium   | tests/files.test.ts:216                     | Added actual stalled-body timeout/abort assertions for cancellation, exact503 codes, failed DB state, hidden pending records, zero reservations and four recovered slots. Corresponding deadline, abort and failed-state mutations fail by assertion.                                                         | Fixed    |
| FILE-I203   | low      | src/server/files/config.ts:28               | Added Azure public/Gov/China accept cases and protocol/host/path/userinfo/client-ID/mixed-mode reject cases. A genuine Red exposed ignored Azurite fields in Azure mode; they are now rejected even when empty.                                                                                               | Fixed    |
| FILE-I301   | low      | src/client/components/project-files.tsx:402 | Unsupported SVG dimension units now give an accurate reason and retain original download. Native and actual browser checks pass; no unit conversion or accepted-policy expansion.                                                                                                                             | Fixed    |
| FILE-I302   | low      | .playwright-mcp/files-browser-proof.mjs     | Browser evidence now records complete beforePdf/afterPdf CSP lists and newViolations. The latest actual replay observes identical lists and an empty PDF delta.                                                                                                                                               | Fixed    |
| FILE-I303   | low      | src/client/components/project-files.tsx:535 | A failed download preserves the distinct preview reason in the same alert; duplicates are suppressed. Native, isolated mutation and actual browser checks pass.                                                                                                                                               | Fixed    |
| FILE-I304   | medium   | src/client/components/project-files.tsx:414 | Self-found repeated-comma/hexadecimal viewBox acceptance had a genuine assertion Red. Explicit separator/numeric-token guards reject both; native, isolated mutations and actual browser controls pass.                                                                                                       | Fixed    |
| FILE-I204   | low      | tests/files.test.ts:320                     | Optional native empty-string row remains future test strengthening, not a behavior defect. A supplemental actual-source probe rejects each empty development field, assertion-kills a truthiness mutant and passes valid/restored controls; source is unchanged. Not counted as a native root regression/Red. | Deferred |
| FILE-I305   | low      | tests/files-ui.test.tsx:265                 | Added accepted whitespace and comma/exponent viewBox controls with/without explicit dimensions. Native images, a new over-strict rejection mutation and actual decoded browser pixels pass. No production implementation defect/change.                                                                       | Fixed    |
| FILE-DOC-01 | medium   | docs/lab-notebook.md:172                    | Marked earlier unapplied002/003 statements as historical without rewriting old entries. Current isolated verification-host state cites the actual prior approved migration metadata, whose PASS/appliedMigrations were read and confirmed. README instructions operate on each environment's pending set.     | Fixed    |
| FILE-DOC-02 | low      | README.md:127                               | Explicitly warns that enabling/restarting the file API before004 is applied fails; migration must precede the enabled API restart.                                                                                                                                                                            | Fixed    |

Current source passes44 application tests, static diagnostics, production build
and formatting. Refreshed isolated mutations pass20 backend and21 viewer cases,
each killed by assertion with passing valid/restored controls. Fresh actual HTTP
replay passes5 cases. The final bundled browser replay passes34 checks, with no
external document request/action and zero remaining native workers.
It additionally checks unsupported SVG units, malformed viewBox tokens, PNG
pixel bounds and simultaneous preview/download reasons. Authentication/backend
responses are synthetic browser routes only; production auth remains unchanged.
Session files/files-browser-proof-results-final.json contains the actual result.
The full gate additionally identified current oracle-only weak retests for both
TEST-SVC-005 and007, not007 alone. Both original pre-implementation assertion
Reds remain historical; no newly failing root Red is claimed. Native Greens,
isolated counterfactual assertion mutations and actual browser checks pass.

README now distinguishes implemented file operations from operator activation,
documents exact settings/limits and warns that db:migrate applies every pending
001..004 migration even when file storage is disabled. Prior sections are
historical observations, not current readiness claims. Native current task
receipts, full gate, post-fix review convergence and live activation are separate;
only the first two are being revalidated automatically. Live004/configuration,
persistent emulator startup and explicit service restart remain unauthorized.

Documentation-only fix review converged after FILE-DOC-01/02 were corrected:
the same independent Sonnet5.5 reviewer verified both current frozen prose
hashes, prior migration metadata and only the fix diff, with no new actionable
finding. This is not an implementation review pass. Japanese prose optimization
completed: README97 and notebook100, reading-load100 for both, zero structural
findings and passing edit invariants. Three pre-existing README informational
patterns were intentionally retained for accurate actors/endpoint descriptions.

The first current full gate passed planning and all42 native TEST bindings, but
failed required Markdown formatting and six no-undef errors in the new PDF asset
copy script. The real Node URL constructor is now explicitly imported; the
existing required formatter is applied to both touched documents. Prior failed
gate/check-output receipts are retained. Earlier TS-only static diagnostics did
not cover that MJS lint gap; they are not represented as a passing full lint.
Formatting and the two-weak-test disclosure require fresh document snapshots
and native task/full-gate revalidation before implementation-review convergence.
The same documentation reviewer checked the formatted table-only delta and
corrected005/007 footnote against fresh frozen prose hashes: no new actionable
finding, both FILE-DOC items remain fixed. Current full lint/format and static
diagnostics pass. The notebook's entire pre-existing historical prefix was
mechanically confirmed byte-identical.

Current native verification now passes all nine tasks with freshly adopted
receipts; plan consistency and the actual full SDD gate both pass. Typecheck,
full lint,44 application tests, build and the complete required format command
all ran successfully, without no-run or changed-only substitution.
The native gate retains42/42 TEST bindings, including the two explicitly weak
oracle-only retests005/007 and five existing implementation-reapproval
recommendations for human-approved features. No human reapproval is invented.
Implementation delta-review convergence remains the next independent stage;
none of this authorizes live migration/configuration or publication.

Round2 implementation review: storage completed two consecutive clean delta
passes, verifying the actual timeout/abort/Azure tables and corresponding20
assertion-killed mutations. Optional FILE-I204 was checked against current real
configuration and an isolated truthiness mutant; all three empty-field controls
pass. The native empty-string table row itself remains an explicitly optional
coverage improvement. Source config hash is unchanged.

Viewer round2 first pass was clean, but its second oracle/evidence pass found
FILE-I305: safe controls had no viewBox, so over-strict rejection was untested.
That pass is NOT counted as clean convergence. Accepted plain-space and
comma/exponent viewBoxes, with and without dimensions, are now native controls;
all22 viewer mutations, including over-strict viewBox rejection, fail by
assertion with passing valid/restored controls. Fresh actual browser replay
passes36 checks, including both new SVG pixel controls, zero remaining workers
and no external document fetch. A first attempted replay could not find a
new fixture beyond the initial4-item page; its retained pagination setup failure
is excluded, not treated as an implementation defect or passing evidence.

The TEST-SVC-006 oracle-only retest correctly passed existing production code
and is explicitly weak. Current weak retests are now005/006/007; the earlier
strong initial and grammar-bug assertion Reds remain historical. No watched
production source was broken to manufacture Red evidence. Production code did
not change for FILE-I305. Current native receipt/full-gate refresh and two clean
post-I305 viewer passes are required before final completion.

Post-I305 machine refresh completed: all nine current tasks and plan consistency
pass, followed by actual full SDD GATE PASS for typecheck, lint,44 tests, build
and complete format. Native42 TEST bindings now explicitly report the three
weak oracle retests005/006/007. No human reapproval or live activation was
recorded. The notebook's small counts/footnote delta also received a clean
independent document review; README and production implementation are unchanged.

### Final implementation qualification (post-I305)

- Frozen r3 manifest SHA256: `edba5439c242500f51cad558d49a1c7713eb1aab0ec3791c30d0cb7a530b71e3`; all34 current entry snapshots and23 machine-evidence snapshots verified. Backend scope is unchanged from r2; final seven built/served assets remain byte-identical to browser-tested bytes.
- Claude Sonnet5.5 storage reviewer `8887643b-5c7a-4b04-92bb-1991e4d534df` completed two clean implementation passes on r2 (turns11/12). Viewer reviewer `e3c421d6-fd0c-449d-8950-453de8d65a17` completed two consecutive clean post-I305 delta passes on r3 (turns9/10), including accepted controls,22 mutation results,36 browser checks, frozen hashes and actual gate header/weak warnings. Neither viewer pass re-reviewed unchanged PDF/runtime/backend code.
- Actionable Open findings:0. FILE-I305 Fixed; FILE-I204 remains Deferred optional native table coverage, supplemented by an actual-source empty-field probe and isolated assertion-killed mutant. FILE-I201 remains Rejected with its earlier owner-fence rationale.
- Current machine evidence: nine complete/current tasks, plan consistency and actual full gate PASS;44 application tests,42 native TEST bindings,20 backend plus22 viewer isolated assertion kills with valid/restored controls, five HTTP cases,36 browser checks, no final active workers or outside document requests.
- Three current weak oracle retests005/006/007 and five implementation-reapproval warnings remain explicit limitations; historical original/grammar assertion Reds are not relabeled current. Existing startup/SVG/settings CSP diagnostics are not claimed absent. The failed pagination-fixture browser setup remains retained and excluded.

## Durable job foundation: design delta

This section does not supersede the file qualification above. REQ-SVC-003 is
proposed for activation with REQ-SVC-010..014; no production implementation or
new human approval is claimed. Both independent design reviewers used
Claude Sonnet 5.5 and only the job specification delta.

| ID       | Severity | Disposition                                                                                                                                                                                                                                                     | State |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| JOB-D101 | medium   | Require a matching token AND strictly unexpired DB-time lease for success/error/stop acknowledgements, including pre-reconciliation races.                                                                                                                      | Fixed |
| JOB-D102 | medium   | User confirmed a fixed30-second cancel deadline; repeat requests/heartbeats cannot extend it; expiry is failed/cancellation_unconfirmed, never confirmed stopped.                                                                                               | Fixed |
| JOB-D103 | low      | Pin project/malformed-job404 then disabled503 without job-table access, followed by enabled job404 and input validation. Explicit error-event shutdown settlement is failed/interrupted unless already owner-cancelled; unconfirmed settlement awaits recovery. | Fixed |
| JOB-D201 | low      | Specify strict query/body/status/response contracts and cancel200; disabled routes need only existing projects even before005, with the same503 for every well-formed job ID.                                                                                   | Fixed |
| JOB-D202 | medium   | Store all timestamps as timestamptz(3); pin exact millisecond cursor representation and tied/adjacent-time controls.                                                                                                                                            | Fixed |
| JOB-D203 | low      | Pin parsed-JSON semantics, sorted own keys/numbers/arrays and recursive unsafe-key/integer rejection; no prototype-bearing accumulators.                                                                                                                        | Fixed |
| JOB-D204 | low      | Composite FK uses RESTRICT; project deletion/ownership transfer APIs remain unimplemented.                                                                                                                                                                      | Fixed |
| JOB-D205 | low      | State exact tenant/object quota key, registered-type claims and visible cancellable unknown-type queued jobs retaining capacity.                                                                                                                                | Fixed |

Fixed denotes design text corrections only, not passing implementation tests.
Initial spec-only reviewers did not inspect all spike code; the parent actually
ran the isolated PostgreSQL spike. The initial ESM setup failure is retained
and excluded. Fresh frozen delta verification and human approval remain pending.

Final design-fix verification: the frozen v3 specification
`c36a0f59a7f7a1ab51ee05861c829379bbc0c7400b88f02d2390b0e6fd5a6885`
and manifest
`8c7d7307a4c4a5f0f8b621c04b808178b3e52947599166bc226260084df95617`
were independently verified by Claude Sonnet 5.5. The final bounded fix pass was
clean; JOB-D101..205 have no unresolved design finding. The preceding v2 pass
still found the shutdown-event wording gap and is not clean convergence.
Production implementation and native Red/Green remain unstarted. All96 captured
non-spec context artifacts and the prior approvals file remain unchanged.
Human approval of this exact specification, not previous implementation changes
or live operation, is the next stage.

- No release/publication approval, live migration004, actual environment change, persistent emulator startup or explicit service restart occurred. Real Azure/real-user file operations and Japanese PDF rendering remain unverified. Only this chronological ledger closure follows the frozen review; source/oracles/docs and native check inputs are unchanged.

## Durable job foundation: implementation evidence

The user approved only the exact job specification above. Its SHA256 remains
`c36a0f59a7f7a1ab51ee05861c829379bbc0c7400b88f02d2390b0e6fd5a6885`;
this does not reapprove earlier implementation differences or live operations.
The foundation includes PostgreSQL persistence, owner-scoped HTTP routes and a
separate worker with an empty production handler registry. No real job body,
Docling, Python/R execution, chat streaming or job UI was implemented.

- Native TEST-SVC-008..013 each have genuine assertion Red and Green evidence.
  The transition test enumerates all42 state/event cells. Additional assertion
  Reds reproduce heartbeat-loss success publication and rejection of a real
  empty HTTP body stream; both corrected controls pass.
- Isolated mutation replay passes22 assertion kills with22 restored controls,
  plus baseline/final complete job-suite controls. The first run's Vitest
  `.rejects` assertion-classifier failure is retained and excluded; a known
  assertion-stack classifier corrected the evidence runner, not production
  code. Per-project1 is implied by owner1 and immutable project ownership;
  no independent kill is claimed for removing that redundant predicate.
- Actual task-owned HTTP/subprocess qualification passes six grouped checks,
  including SIGTERM, interrupted recovery and the actual15-second shutdown
  watchdog. Zero owned children remain. The initial empty-stream HTTP failure
  is retained, not counted as a pass. No existing service/process was stopped.
- Current evidence lives under session
  `8b317095-2f1b-416c-a0c9-c6f1aa14aed6/files`: `jobs-mutation-results.json`,
  `jobs-runtime-results.json`, per-TEST native Red/Green logs and separate
  heartbeat/empty-stream regressions. Production bytes were unchanged by the
  isolated mutation run.
- README/notebook structural diagnostics have zero findings. GiNZA quick
  diagnostics score97/100; three existing README informational patterns are
  retained outside this delta. Frozen prose invariant checks pass unchanged.
  Independent contract/document review remains pending.

Final task receipts, full-project gate and frozen implementation delta reviews
are still pending at this entry. Three inherited weak oracle retests005/006/007
and five implementation-reapproval warnings remain limitations. No live
migration004/005, actual environment change, persistent emulator, explicit
service restart, commit, push or publication is authorized or performed.

The first final native task verification exposed a genuine compatibility
regression: disabled jobs added `jobsEnabled:false` to the existing internal
configuration shape, breaking unchanged TEST-ID-003. The failed native receipt
and output remain retained. A new TEST-SVC-013 assertion reproduces the same
failure with a native Red; production now omits the optional setting when
disabled and includes it only when enabled. The native Green and combined
identity/job suite pass10 tests; public configuration remains unchanged.
This is a fixed deterministic regression, not a flaky retry or test weakening.
Isolated delta qualification additionally kills both configuration mutants
and re-kills heartbeat-loss/aborted-start against the changed TEST-SVC-013,
with all four restored controls and baseline/final job suites passing.
The combined matrix therefore covers24 distinct mutants (26 qualified
observations), not26 distinct cases. Unchanged mechanisms were not rerun.

Final machine qualification now passes all ten native tasks with fresh,
actually executed receipts, plan consistency and the full SDD gate. The
shared-test-file move guard initially rejected008..012 after the013 addition;
their unchanged expectations were revalidated with native `tdd refactor`,
not weak retests or manufactured Reds. That failed receipt remains retained.
The full gate ran typecheck, lint,50 application tests, build and the complete
format command;48 native TEST bindings pass with the same three weak oracle
retests and five human implementation-reapproval warnings. Independent frozen
implementation delta reviews are the next stage; no live activation follows.

### Frozen implementation review findings

The r1 manifest is
`1ffddf7e52842eef7c4638a1e151428c56b81ed7d0b684da600c901d8a5bdbef`.
All18 snapshots,120 machine-evidence hashes and89 unrelated baseline artifacts
were verified. The120 evidence files were additionally archived byte-for-byte
before later journal appends and evidence-runner updates. Source snapshots
and the original manifest remain immutable.

| ID       | Severity | Disposition                                                                                                                                                                                                                              | State    |
| -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| JOB-I101 | medium   | Missing cancellation-plus-shutdown settlement coverage under TEST-SVC-013. Add a promise-gated cancel_requested control, cancelled/null-code settlement and a mutant that survived r1 but fails the new assertion; requalify before review. | Open     |
| JOB-I201 | low      | Schema-normalized idempotency would contradict the approved raw canonical-JSON contract and can double-transform worker input. Admission validates raw input; workers parse again before executing. Future schemas need activation contracts. | Rejected |
| JOB-I202 | low      | README already requires005/all pending migrations, real handler registration and separate activation consent. Enabled-without005 behavior is optional operator detail; only enqueue, not every cancellation POST, rejects unknown types.   | Rejected |

Claude Sonnet5.5 contract reviewer independently accepted both Rejected
dispositions and reported a clean bounded second pass with document verdict
PASS. The state reviewer's first code-only response omitted the spec/tests
and is excluded from clean-pass counts; its completed evidence pass found
JOB-I101. No clean-convergence claim is made at this point.

JOB-I101 is now Fixed pending independent fix review. The added assertion
holds a cancelled-then-shutdown handler behind an explicit promise gate:
state stays cancel_requested until release, then becomes cancelled with a
null failureCode. The isolated joint state/event mutant survives the original
r1 TEST-SVC-013 (exit0), fails the new assertion with
`expected 'failed' to be 'cancelled'` (exit1), and passes restored controls.
Four existing013 mutants were requalified against the changed test. Across
the retained waves this is25 distinct mutants and31 assertion-killed
observations; the intentional old-oracle survivor is not a qualified kill.

Production/specification bytes are unchanged. This coverage-only addition
has native T2 refactor evidence, not a new native Red; the refactor command's
warning is retained. The isolated assertion Red and restored Green establish
the new oracle's discrimination without fabricating a production defect or
weak native retest. Fresh job receipt, current ten-task consistency, static
diagnostics and the actual full SDD gate all pass again, including50 tests.
The same three weak005/006/007 retests and five human warnings remain.
Contract/document reviewer passes2/3 are clean on unchanged scoped bytes;
state fix-only review and final convergence remain pending.

### Final durable-job implementation qualification

- Frozen r2 manifest SHA256: `4b64e7dbbeb9540cb628012e66167d07c5925f0068684d78d3b9938bd5d0c091`;18 source/metadata snapshots and143 machine-evidence snapshots. The r1-to-r2 fix diff is `9a8d273914d55c027a40e8c70b127c28796bc0abdccf0e5780a0f464aed6006f`. Production/specification bytes are unchanged from r1; only coverage and verification metadata changed.
- Claude Sonnet5.5 state reviewer `91fe97e1-fc0b-4e40-826a-52470f6e5342` completed two consecutive clean post-JOB-I101 fix-only passes on r2 (turns3/4). Contract/document reviewer `7854e1f3-f2fb-4558-8c64-53cfd512b31d` completed two consecutive clean bounded passes on unchanged r1-scoped API/input/configuration/document bytes (turns1/2); the only added013 case belongs to state review. No unchanged file/viewer implementation was rereviewed.
- Actionable Open findings:0. JOB-I101 Fixed; JOB-I201/I202 Rejected with independently accepted contract/document rationales. The initial incomplete state response, acknowledgement-only turn and pre-fix evidence-gap finding are excluded from clean-pass counts.
- Current machine evidence: ten complete/current task receipts, plan consistency and actual full SDD GATE PASS;50 application tests,48 native bindings,25 distinct isolated assertion-killed mutants (31 observations across targeted requalification waves), baseline/restored controls and six actual HTTP/owned-child qualification groups. The old-oracle survivor and initial setup/classifier failures are retained and excluded from passing counts.
- Existing weak oracle retests005/006/007 and five implementation-reapproval warnings remain. Added shutdown/cancellation coverage has native refactor evidence and an isolated genuine assertion Red/restored Green, not a new native Red; its refactor warning is preserved. No retrospective approval or stronger proof is invented.
- README/notebook structure and GiNZA quick diagnostics/invariants pass; the independent document verdict is PASS. The historical notebook prefix is byte-identical. Its earlier pending statements remain chronological records, superseded by this closure and session `files/jobs-final-qualification.json`.
- No live migration004/005, actual environment change, persistent emulator, explicit existing-service restart, real job body, Docling, Python/R execution, chat/UI expansion, commit, push or publication occurred. Real Azure/real-user file operations/Japanese PDF display remain unverified; activation and publication still require separate consent.

Only this chronological ledger closure follows the frozen review. Its frozen
prefix remains unchanged; source/oracles/docs, native receipts and check inputs
remain exactly the reviewed r2 bytes.
