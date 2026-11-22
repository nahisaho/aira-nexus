# Native ledger capacity differential review

Candidate: `native-ledger-repair/manifest-v2.json`, SHA256 `63f22cfb942b4114bfd90a940d75679a7011d0e8dee87b582226a733735d2481` in the session files directory.
Specification: `.sdd/specs/native-ledger-capacity.md`, SHA256 `d34fee3a545a870473f6bc1596a6e2fa81b592e4b6b0bae05a513123e308118e`; explicit human specification approval retained.

| ID | Severity | State | Evidence / resolution |
| --- | --- | --- | --- |
| NLR-I101 | Advisory | Fixed | Clarified that prospective dependencies contain zero-valued draft fingerprints, not current bindings. Retained receipt pointers preserve history, not completion. Actual isolated `workflow-proof.json` proves zero binding refusal, stale retained receipt refusal after official rebinding, then fresh verification/adoption and acceptance. |

Claude Sonnet 5.5 resource/policy reviewer `4feeae96-91f6-4636-a503-89668774e355`: implementation source review CLEAN, then frozen seven-target continuity CLEAN. Read full reader, main/model patches, configuration patch and configuration loader; did not review tests or application source.

Claude Sonnet 5.5 evidence reviewer `812fe7bd-96c5-4f02-a2c2-7f19f7a0b792`: initial non-blocking clarification above, then two consecutive CLEAN rounds. Read full tests, final Red/Green logs, mutation qualification/counts, isolated verification/gate, prospective plan/configuration, workflow proof and three refusal/acceptance logs. Independently checked private 13-event chain and matched final Red/Green log entries. Final round checked frozen seven-target and proof continuity only.

Limits: evidence reviewer did not independently recompute current per-test hashes, review raw mutation source, or review the application DAG. Chain checking alone does not establish current tests. Actual private gate's current 3/3 result remains separate machine evidence. The workflow proof uses two documentation fixtures and tests generic planning provenance, not native execution or application completion.

Machine evidence precedes review: three genuine final-hash assertion Reds/Greens; actual 65MiB native check/verify/fixture gate; seven assertion-killed mutants with restored controls; isolated native task verification and full tooling gate PASS. Old failures and superseded Reds remain retained.

Subsequent shared promotion was explicitly human-approved for the exact seven-artifact manifest above and completed. `native-ledger-repair/root-promotion/qualification.json` records genuine Root assertion Reds/Greens for all three native reader tests, matching per-test hashes, prefix preservation and the actual human implementation approval; no private ledger was transplanted. The current native reader task has a fresh successful Root receipt. Application revalidation was later paused at a completed-task boundary to integrate the newly requested pane scrolling, then resumed against the updated candidate. The final combined Root gate now passes: all13 tasks have current successful receipts; 56 application tests, 57 native TEST bindings, five application checks and two tooling checks pass. The three historical weak Reds and five human implementation-reapproval warnings remain, so qualification is PASS_WITH_RETAINED_LIMITATIONS, not new human acceptance.

Final session evidence: `pane-root/final-qualification.json`, SHA256 `1d8f2fc3997d9c2b3ad923b2197c868ccc2790d867684e1899b920c81a96dd0a`; fixed combined manifest `pane-root/final-manifest.json`, SHA256 `52d09a8b8fb1c231cfa18f2149428b6ee2b5494fd1fc979f16ed9849c9696a17`. These do not broaden the AI review scopes above. Default 64MiB and separate receipt budget remain; explicit 128MiB permits higher memory use, including unchanged legacy whole-file readers. Live migrations, environment changes and service restarts remain excluded from this tooling/scrolling work.

## Proposed 256MiB extension — specification review only

The user selected preparing this specification amendment before continuing
Jobs UI. It is not approval to change the Root reader or configuration.
The Root preflight contained 1381 events / 132433500 bytes; the existing
128MiB cap leaves 1784228 bytes. No history is deleted or replaced.

Proposed specification: `.sdd/specs/native-ledger-capacity.md`,
SHA256 `f8e27a8bf181ffc4dbaac9eb144d3d3df98eaa808a47718f4171610a12c5f118`.
Session evidence directory: `files/ledger-capacity-extension/`.
Frozen `proposal-manifest.json` SHA256:
`63dc88c5f7aaf8d88b9f4dbf064362642febd4aa6184966ff4dbb5b7ab0fcee7`.
Only REQ-NLR-001 changes behavior; the default64MiB, bounded actual reads,
full-history validation and separate receipt/log budget remain unchanged.

Claude Sonnet 5.5 reviewer `f7d913f2-da45-438b-922f-937e951372ff` found no
material specification issues across resource/policy and evidence/history
consistency. This was one independent proposal review, not an implementation
review or two-round implementation qualification. The reviewer did not execute
tests; its evidence scope was the frozen proposal and bounded spike artifacts.

Actual isolated prospective checks: three copied contract tests passed,
including valid129MiB history check/task verification/full fixture gate;
default64MiB and a current explicit128MiB receipt reject that oversized history.
An independent raw-byte probe accepted exactly256MiB and rejected256MiB+1.
Its maximum RSS was585040KiB, not a full-CLI or total-memory ceiling.
The intermediate wrong-control failure is retained in
`native-cli-spike-attempt-2-failed.log`: changing config with an old receipt
correctly produced provenance FAIL1 before capacity inspection. The corrected
control obtains a current128MiB receipt before growing the isolated history.

`root-before.sha256` checks reconfirmed byte-identical Root ledger, configuration,
native reader and CLI after the probes. Synthetic fixture directories and the
large sparse boundary input were removed by their scoped cleanup.
Exact-hash human specification approval, isolated Native Red/Green and mutations,
frozen implementation review, separate human approval of the repository256MiB
opt-in, Root promotion/TDD, affected-task requalification and full gate remain
pending. Historical128MiB receipts do not qualify the proposed new contract.

## Revised 512MiB proposal — supersedes unapproved 256MiB draft

The human did not approve the256MiB proposal, requested512MiB, then explicitly
agreed to include the necessary chunked reading. No new specification approval
or Root promotion has been recorded.

Final proposed specification: `.sdd/specs/native-ledger-capacity.md`,
SHA256 `0904b4a08c41c30544edf3ac67b9e262fb139fa2335f9629c444b89d22669f5b`.
Session evidence: `files/ledger-capacity-extension-512/`.
Frozen `proposal-manifest.json` SHA256:
`a270d17f21e6b2607db634a86c035b2c48c7e7df7eeee9e3d7bb39f35679d528`.
The original approved128MiB spec, rejected256MiB proposal and first512MiB
review candidate remain separately preserved.

| ID | Severity | State | Specification resolution |
| --- | --- | --- | --- |
| NLR-S512-F1 | Medium | Fixed (specification only) | REQ-NLR-004 and Design inventory name readLedger/all callers, native inspect, approvalProvenance, ledgerRegression and gateInputSnapshot. Legacy merge input/output above min(configuredLimit,64000000) bytes must refuse2 unchanged before whole-file decoding/writing; small controls remain required. |
| NLR-S512-F2 | Low | Fixed (specification only) | Opt-in requires a Node/platform/resource manifest, human-approved RAM allowance with measured process/tree headroom, at least8GiB available memory at preflight and serial capacity commands; unavailable resources block activation. |

Claude Sonnet 5.5 reviewer `99a6f308-b74d-4e1e-bfd5-f5119d91467d` reviewed
the frozen specification and bounded feasibility evidence, then the finding
fix-delta, then frozen hash/fix-passage continuity. The final two rounds were
CLEAN. The reviewer did not execute tests, audit the full implementation, or
independently reverify all22 evidence hashes or Root baselines. The parent
verified all22 manifest entries and unchanged Root ledger/config/reader/CLI
hashes separately. These are proposal-review results, not implementation
qualification.

Actual isolated evidence: combined6/6 controls passed, including a valid
exact512MiB history check/fixture gate, task verification near511MiB with
append headroom, and split UTF-8/BOM/record/growth controls. A separate bounded
Git blob512MiB capture/JSONL parser probe passed and refused insufficient
capture with ENOBUFS; it is not integrated Git-baseline CLI/chain evidence.
The single-string512MiB failure and two earlier prototype failures remain
retained. In particular, verification at the exact byte ceiling appended
evidence before overrunning its budget, motivating the unimplemented
REQ-NLR-005 pre-append refusal.

The6-control process maximum RSS was2583080KiB (about2.46GiB); this is not
aggregate concurrent RSS or a runtime memory guarantee. The proposed64MiB
per-record guard and64,000,000-byte legacy-merge guard are explicit new
constraints. The current132433500-byte Root ledger already exceeds the latter,
so large legacy merge would refuse after implementation, not become512MiB-safe.
Large generated inputs/Git objects were cleaned in their owned fixture paths.

Human approval must show the exact specification path/hash, memory and new
record/merge constraints. Integrated Git/merge controls, pre-append guard,
five formal Native TEST bindings, implementation/mutation review, separate
frozen-artifact512MiB opt-in approval, Root Native evidence and actual
affected-task/full-project requalification remain pending. Root still uses
the byte-identical explicitly128MiB configuration and original tools.

## 512MiB isolated implementation qualification

The human approved the exact0904b4a08c41c30544edf3ac67b9e262fb139fa2335f9629c444b89d22669f5b
specification and its isolated-work Design. The official Root approval appended333
bytes; the original132433500-byte prefix remains unchanged. The later approval
of the512MiB switching direction is not an approval of previously unseen frozen
implementation bytes or a release authorization.

Session `files/ledger-capacity-extension-512/isolated/` contains an independent
small-ledger workspace with the identical specification, scoped plan and actual
Native assertion Reds/Greens for all five TESTs. Changed existing behavior was
repinned with bounded counterexamples, not passing Reds disguised as failures.
All13 bounded mutations were detected and byte-restored; an additional restored
Git-diagnostic mutation reproduces the512MiB stderr/string-limit failure.
The corrected diagnostic converts at most4096 captured bytes to text.
Exact512MiB current and committed Git histories,64MiB record boundaries,
64KiB reads, merge input/output refusal, exact-fit/over-budget append,
approval publication, released locks and failure receipts are exercised.

Final actual private receipt:
`.sdd/plan-evidence/51bf7f1a1155c139573790a79d51c1e2314b63d8ed94d8ceb4ade6d30e16e457/797a30b19e5079b71ff0a886ad57a93a1c562f3e324facb71c8a525329c67105.json`.
Its adopted task and full isolated tooling gate PASS; five Native bindings have
no weak/suspect evidence. Existing selected ledger/approval/BOM/CRLF regressions
also passed93/93. This is not the application/Root full-project gate.

Frozen four-artifact manifest:
`files/ledger-capacity-extension-512/implementation-manifest.json`,
SHA256 `c3ebea5ea129ee7f2483b1936fa6ca7824546860dc689321743b05f2905f2d17`.
Node24.22.1/linux/x64 final qualification sampled3056036KiB maximum process RSS
and4227452KiB owned-tree RSS; an earlier formal run sampled4269432KiB tree RSS.
These are samples, not hard limits. Proposed opt-in allowance8GiB, available
memory preflight8GiB and serial capacity commands require final human consent.
Root code/configuration remain original and explicitly128MiB; no isolated
ledger or receipts may be transplanted. Large legacy merge will refuse2 because
the current Root history already exceeds64,000,000 bytes.

Independent frozen implementation review completed as recorded below. Separate exact-artifact
Root opt-in, genuine Root Native evidence and fresh affected-task/application
qualification remain pending.

Frozen review round1: Claude Sonnet5.5 reader reviewer
`6b9677f2-f5b0-46fe-a979-616309b19750` reported the row below, verified
manifest/spec hashes but did not check all four artifact hashes or tests.
Writer reviewer `2859149d-b370-4ecd-a8b4-d0198a16a247` was CLEAN for
lock/refusal/publication/merge source and focused tests, independently verified
all four artifact hashes, and explicitly did not inspect actual receipt fields.

| ID | Severity | State | Disposition |
| --- | --- | --- | --- |
| NLR-I512-F1 | Medium | Rejected, independently confirmed | The suggested omitted-planning opt-out contradicts the existing default-on contract: omitted config/planning/required enables planning; only explicit required:false disables it. The standalone fallback's conditional validates fields; its final refusal is unconditional. No policy-weakening source change was made. |

Both synchronous reviewers could not receive follow-up messages in this host.
At that point a bounded continuation was still required to close the disputed
default-on interpretation and remaining hash/test/receipt checks.

Bounded continuation reviewer `94079d68-4d43-4860-9f8c-37ca03d6e843`
(Claude Sonnet5.5) independently rejected F1 using the approved default-on policy,
frozen sdd.mjs:1152-1154/7060-7083 and CLI007 controls. It checked the remaining
reader tests, all four hashes, actual receipt status and nested-exit2 receipt
construction, then returned CLEAN. A second same-context continuity round
recomputed the unchanged spec/manifest/four-artifact hashes and returned CLEAN
again. Neither review reran tests or qualified Root/release; no source fix was
needed for the rejected finding. There are no open implementation findings.

The final mechanical audit in
`files/ledger-capacity-extension-512/qualification-supplement.json`
(SHA256 `d261109e1f9119bfa4309cac18f1d0f240a531327d9d2476c90cd8869fa0b1a9`)
checked all frozen evidence hashes, the27-event private chain, five matching
strong-Red/current-success test hashes, the actual private receipt hash and
93/93 existing selected regressions. All original Root mjs files, configuration
and complete132433833-byte ledger still match the unpromoted baseline.
Isolation is complete; exact four-artifact/8GiB-condition human opt-in and
genuine Root qualification remain pending.

The human subsequently approved the displayed exact four paths/SHA256s and
8GiB/free8GiB/serial conditions (`human-root-opt-in.json` in the session evidence).
`root-promotion.json` records exact-byte promotion with configuration last:
Root now explicitly uses536870912 bytes. No private ledger/configuration/receipt
was transplanted, application services were not restarted and production Docling
was not enabled.

`root-native-cycles.json` and `root-native-audit.json` record genuine new Root
assertion Reds/Greens for all five TESTs, with bounded counterexamples atomically
restored to the exact approved source after every Red. Both the original
132433500-byte prefix and the later approved132433833-byte prefix are unchanged;
Root now has1392 events/133606651 bytes after those ten genuine cycles.
`root-native-resources.json` measured3051008KiB maximum process RSS and4782468KiB
owned-tree RSS (about4.56GiB), within the approved8GiB allowance; sampled available
memory stayed above8GiB. Native cycles do not replace the pending actual Root
task receipt, affected-task requalification or application full-project gate.

Root `native-ledger-reader` task verification subsequently passed and adopted
receipt `6017c13eef402400a6bb7fdf744e5c5718ed446d69ad8eed44b2b0f3e8ebbb33/6529f648d809ef077722c01bf9a56fbf2a8ae3bf2c41f529bacb345b317ff744.json`
under `.sdd/plan-evidence/`. All20 affected implemented tasks were reverified
serially and their actual PASS receipts adopted. The post-requalification plan
consistency check passed:21 tasks complete and `conversion-jobs-ui` not started.
`root-native-audit.json` confirms the four approved file hashes, both history
prefixes and the complete1503-event chain (146797929 bytes). The serial
requalification sampled at most3062728KiB owned-tree RSS, with available memory
remaining above8GiB. These results do not constitute an application full-project
gate or authorize production activation.
