# Workbench specification review
Spec sha256: 4fbff51c3a058cc932d27658727581004960edb7b92c60f21b8bd8ca88b7967a
Previous specification review: d9e11a4494fa3ab62fa18ba583688d5ba1d95c9f582c007f2e13090a9f7a3ca1
R-UI-01|medium|.sdd/specs/workbench.md:12|Resolved: 401 clears state, late old-session responses discarded; expiry and sign-out race tests authored.
No live-provider or Notebook completion claims permitted.
UI stack delta: Tailwind CSS / @tailwindcss/vite + Radix-based shadcn/ui + lucide-react; documentation-only change reviewed by Claude Sonnet 5.5. No new approval lock or implementation evidence recorded.
R-UI-02|low|docs/prompts/phase-1.md:35|Resolved: require pre-generation preset selection and post-generation components.json/import/dependency checks instead of trusting CLI defaults.
R-UI-03|low|docs/prompts/phase-1.md:36|Declined: component names are examples, not an exhaustive allowlist; the prompt already restricts additions to components needed for phase 1, so a necessary Dialog is not excluded.
Delta review status: CLEAN after Claude Sonnet 5.5 checked both resolutions. Implementation/authentication approval remains pending.
Japanese prose optimization completed: prompt 100 → 99 (intentional repeated CLI subject retained), architecture 96 → 96 (existing claims enumeration retained), requirements 100 → 100. Structural lint, final-draft invariants and targeted Prettier checks pass; no prose-only rewrites were needed.
Workbench whole-file spec binding matches the plan. Existing prerequisite fingerprints remain unbound; this documentation check is not a full plan check or application gate pass.

## Foundation implementation delta
2026-11-12: Claude Sonnet 5.5 reviewed the fixed client/README manifest after typecheck, lint, formatting, build, 13 native tests and trace passed.
R-UI-04|high|src/client/auth.ts:30|Fixed: logout popup now returns to the same registered blank auth-redirect.html as login; README states the exact URI.
R-UI-05|medium|src/client/auth.ts:37|Fixed: remove cached-account auto-selection; invalidate the MSAL active account on 401 and failed logout, so reload requires explicit sign-in.
R-UI-06|medium|src/client/api.ts:46|Fixed: AuthError including silent-token timeout produces an actionable re-sign-in failure, not a generic connection hint.
Regression evidence: TEST-UI-003, TEST-UI-004 and new TEST-UI-006 each recorded assertion Red against the reviewed defect, then Green after the fix. Unchanged test bodies were revalidated after the shared import change. Native suite now has 14 passing tests.
README Japanese prose: 98, two informational repeated-lead findings intentionally retained (sequential SPA configuration steps and inline-code masking). Final wording and independent delta re-review pending.
Final delta review: Claude Sonnet 5.5 found no actionable issues in the source/README fixes; a second narrow post-fix pass checked the new auth regression tests and their production call sites, also clean. Test-prototype controls do not establish live MSAL storage/provider behavior.
Final README Japanese prose optimization completed: 94 after the substantive review fixes; the verification-scope enumeration is intentionally retained alongside the two informational repeated-lead findings. Structural lint has zero findings and the final handoff invariant check passed. No prose-only edits or normative changes were made by the optimizer.

## Dynamic workspace navigation and pane resizing design

Current proposed spec sha256:
`bfcbce887c0462b6d20379b03e27dc6ac131da93805db1463d26c448c70cba84`.
The user confirmed Chat then Notebook then files, and tab behavior only;
actual file I/O remains deferred. Pane resizing is page memory only.
Existing REQ-UI-002/003 remain unchanged; REQ-UI-001 changes the initial
tab layout; REQ-UI-004..008 add the confirmed interactions.
The isolated real-browser feasibility prototype passed Radix keyboard,
sibling-close focus, native drag and pointer capture; an earlier CommonJS
import setup failure is explicitly excluded from passing evidence.

| ID | Severity | Evidence | State |
| --- | --- | --- | --- |
| UI-D101 | medium | Tests now emit capture loss after pointerup/Escape/cancel; completed release cannot revert a committed width. | Fixed |
| UI-D102 | medium | Drop placement is explicit: rightward after, leftward before; tests include backward/self/close-button/cancelled drops and dragOver preventDefault. | Fixed |
| UI-D103 | low | A file named AIチャット must remain Japanese after fixed AI chat/control translation. | Fixed |
| UI-D104 | low | Tests cover keyboard bounds, ARIA ranges, owner scope reset and absence of width storage; the resizer now requires an explicit user scope. | Fixed |
| UI-D105 | low | Empty ID/name throws, same-ID reopen updates title, inactive close restores active focus; sub-minimum viewport retains CSS minimum1024 and horizontal scrolling. | Fixed |

These are planned-test/design fixes, not production implementation or Green.
Design convergence: two consecutive clean Claude Sonnet 5.5 passes, same
bfcbce887c0462b6d20379b03e27dc6ac131da93805db1463d26c448c70cba84 hash.
Native auto lock recorded. Pre-implementation native consistency was attempted
and failed: retained history compares the prior task definition even with
current authored bindings. No history was removed or fabricated; actual fresh
verification remains required after implementation and native Green evidence.

## Workspace implementation verification

Native assertion Reds and Greens were actually recorded for TEST-UI-001
(confirmed behavior retest) and TEST-UI-007..012, with unchanged test bodies
between each Red and Green. Existing UI002..006, CON001 and PREF003..005
were revalidated with native refactor; test-helper oracle-change warnings
remain visible and are not represented as new Red evidence.
Native diagnostics PASS; all 37 application tests PASS; production build
and repository formatting PASS. Existing bundle-size warning remains.
Actual browser replay passed 21 checks: native bidirectional file drag,
pinned rejection, close focus, deduplication/rename, filename translation,
both captured pointer handles, committed release, Escape, keyboard limits,
real ResizeObserver shrink/1024px scrolling, scope reset, actual App project
switch and English/Dark settings. Authentication/API were browser-only fakes,
not a production bypass or live provider claim; browser context was closed.
Sixteen isolated copied-source mutations failed by assertion with valid
and restored controls passing; live watched source was never mutated.
Commands/results are in session files/workbench-ui-{red,green}-*.log,
workbench-ui-{implementation-diagnostics,browser-proof,mutation-results}.json
and workbench-ui-mutations.mjs. A trial observer-registration mutation
survived the fake observer (which does not model observe registration);
this is an explicit test limit, not a killed mutation. The actual browser
shrink proved registration, and the callback mutation failed by assertion.

Independent implementation reviews: Claude Sonnet 5.5 reviewed two bounded
risk axes (tab state/contract and pane pointer/bounds/contract) against the
10-file workbench-ui-review-manifest.json frozen in session files. Initial
responses explicitly under-read assigned tests/ledger; same-agent follow-ups
completed that coverage rather than counting partial results as approval.
Both reviewers then confirmed a second unchanged-hash clean convergence pass.
Actionable Open implementation findings: zero. Supplemental untested cases
remain isPrimary=false and symmetric keyboard branches; no sign-handling
mutation or exhaustive browser-keyboard coverage is claimed. Existing
TEST-UI-001 verifies ArrowRight from Chat to Notebook. No source, test or
canonical spec changed after the review freeze.

## File-service compatibility design delta

The approved research-services activation supersedes the historical blanket
file-disabled assumption, without enabling chat or Notebook execution.
Current workbench spec sha256:
`6ff52070577c93f1c1409b00a8e7f223103fccb28911fa0fac9b4a0aa69eb8fa`.
Only REQ-UI-003's delegation and the related design/assumption boundary change.
FILE-W101|medium|.sdd/specs/workbench.md:27|Fixed: renderer key is scope/file ID only; same-ID names preserve the mounted viewer.
FILE-W102|low|.sdd/specs/workbench.md:27|Fixed: inactive renderer content unmounts and discards renderer-local state.
Two Claude Sonnet 5.5 risk axes reviewed the frozen compatibility delta;
both found the fixes clean in two consecutive post-fix passes; the second
checked unchanged hashes/dispositions only. Native auto re-lock is next. This is design only,
not file implementation evidence or a full gate.

## Central project-name editor removal

The user approved exact workbench contract SHA256
`50d7cfcaef447e8141e8f2074268b8c81bd0ca104dc54d2212720768a14cdbe2`.
This presentation-only amendment removes the central selected-project name
input and Save name button while retaining the selected heading, sidebar
settings rename, project-write guard and all project/authentication APIs.
The unused central handler/state/imports and its two catalog entries were
removed; no database, configuration, API or project-dialog code changed.

TEST-UI-002 first failed by assertion against the existing central input.
All24 workbench/sidebar tests then passed, including acknowledged settings
rename/remount and409 error handling. A bounded restoration of the central
controls failed the same absence assertion, then was removed. Actual-browser
Japanese/English checks verified no central editor/save action, retained
heading/tabs, and real settings name/description writes surviving a reload
through production authenticated routes and disposable PostgreSQL.

The first diagnostics/full-gate attempt found two test-only unsupported
Testing Library `exact` options; both were removed. The corrected diagnostics
and targeted formatting passed, and the isolated production build succeeded.
The final full application gate is recorded separately before publication.
This amendment has no independent Claude-review claim.

Native Red initially refused the stale T2 specification approval; genuine
human approval was subsequently recorded. Native Red then refused the existing
4096-directory check-discovery budget, and the bounded plan check timed out
after15s. No native evidence, successful task receipt or qualification was
invented; the historical prerequisite fingerprints/receipts are retained.
Publication requires separate exact-artifact human approval.
The corrected full application gate passed typecheck, lint and all tests.
The owned fixture tab/server/database were stopped; live services stayed up.

## Edge-like workspace tab visuals

The user approved exact workbench contract SHA256
`2d15802a94a5669ab32118d500897ec03271cb25d7126a3bafaa0b88379aa0a8`.
Only WorkspaceTabs markup and its scoped stylesheet change: non-interactive
pseudo-elements paint a narrower-top/wider-base trapezoid around each trigger
and its sibling file-close button. Shared Tabs primitives and state transitions
are untouched. Root/strip gaps are removed and only the panel's top corners
are squared; existing content padding and bottom corners remain.

The actual-browser TEST-UI-001 visual assertion first failed on the existing
32px strip/view gap, rounded panel top and missing trapezoids. Green passed
32 combinations of two themes, four text sizes and four selected tabs:
zero gap, trapezoids for fixed/file tabs, matching active/panel background and
unclipped real controls. Actual drag, keyboard reorder/selection, file close,
English labels, visible2px focus and480px horizontal-wheel overflow passed.
Spacing8px and rectangular-shape runtime CSS mutations were caught; after
removing each fault, the same browser assertions passed.

A genuine integration counterexample found the shared trigger's invisible
underline extending4px below the strip and causing vertical focus scrolling.
The workspace-only override disables that unused pseudo-element; the shared
primitive is unchanged. Canonical Vite CSS freshness was explicitly verified
after refreshing a stale transform by touching unchanged-content source.
No live data, authentication, API or configuration change is involved.

All nine focused workspace/workbench tests, TypeScript/ESLint diagnostics,
targeted formatting and the isolated production build passed. Full application
gate completion is recorded before publication. This visual amendment has no
independent Claude-review claim. Native qualification remains incomplete:
the approved native Red refused the existing4096-directory discovery budget,
and bounded plan consistency timed out after15s. No native receipts or
prerequisite fingerprints were fabricated. Separate exact-artifact human
approval is required to publish.
The final full application gate passed typecheck, lint and all tests.
The owned standalone browser tab was closed; no fixture server/database was needed.
