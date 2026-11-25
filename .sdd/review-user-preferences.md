# User preferences review

Scope: new user-preferences contract and only the workbench default-language
assumption. Existing human-approved Copilot specification is unchanged.
Two parallel Claude Sonnet 5.5 design reviews verified the initial hashes.
An actual capped PostgreSQL spike verified concurrent field-preserving UPSERT,
tenant separation and a separate-connection persisted read; fixture stopped.

| ID | Severity | Evidence | State |
| --- | --- | --- | --- |
| PREF-D001 | low | Full strict GET/PATCH responses, default insertion and merged-field acknowledgements are explicit; no synthetic success on malformed replies. | Fixed |
| PREF-D002 | low | Failed GET blocks editing and exposes retry; pending save retains prior values and a saving status. | Fixed |
| PREF-D003 | low | Existing sanitized 500/request-ID error handler covers DB errors; invalid content type is 400, oversize 413. No unrelated method-policy changes. | Fixed |
| PREF-D004 | low | Request identity is verified (tid,oid) only; parameterized SQL never accepts identity fields from a body. Existing Japanese errors and request-ID values are preserved. | Fixed |
| PREF-D005 | info | Pending first read uses defaults and may transition to saved appearance. Avoiding all initial flashes would require a separate authenticated bootstrap; it is not promised. | Rejected |
| PREF-D006 | info | Timestamps, destructive rollback, database-role grants and RLS are not required for two preference fields; existing query-boundary ownership is retained. Live migration needs separate consent. | Rejected |

No implementation or live migration is claimed at this design stage.

## Implementation review

The later implementation was frozen in session artifact
`preferences-implementation-manifest.json`, SHA256
`fe37ceadb3735a0fb837a3a94b45b9350da9ebc3d658f0e624e251e3130ea010`.
Its 22 exact paths and hashes include the unchanged Copilot contract.
Before review: all 31 application tests, five native preference Greens,
TypeScript/ESLint diagnostics, formatting and production build passed.
Nine isolated assertion mutations and valid/restored controls passed without
changing the source watched by the live development service.

| ID | Severity | Evidence | State |
| --- | --- | --- | --- |
| PREF-I001 | info | Claude Sonnet 5.5 reviewed scoped ownership, strict input, bounded JSON, atomic partial writes, wire errors and deployment instructions; remaining API test/notebook coverage was explicitly completed in the same reviewer context. | Fixed |
| PREF-I002 | info | A separate Claude Sonnet 5.5 review covered owner-fenced state and, on follow-up, catalog/rendering, root/portal tokens, GitHub dependencies, explicit fixtures and UI assertions. Neither partial initial report was counted as reviewing unread files. | Fixed |
| PREF-I003 | low | Additional HTTP foreign-tenant, injected DB-500 and exact-16384-byte preference cases were not added. Repository tenant isolation, strict/oversized input and existing identity/error middleware are covered; no observed implementation defect requires those extra cases. | Deferred |
| PREF-I004 | low | Dedicated UI assertions for malformed replies, held-save disabling and the GitHub button during a failed preference GET remain supplementary gaps. Review verified the strict guards, disabling and independent rendering; current tests and browser evidence do not claim those exact assertions. | Deferred |
| PREF-I005 | info | The server review's failed-save coverage concern is covered by TEST-PREF-004 in the separately reviewed UI suite; it is not an untested failure claim. | Rejected |

Both reviewers completed a bounded no-change delta/hash check after their
remaining assigned evidence. No actionable implementation findings are open.
Reviewers did not rerun machine checks or authenticate against real providers.
Browser-only synthetic routing verified actual Light/Dark colors, English
panes, unchanged user input, reload, no language/theme-triggered project or
GitHub refetch, contrast and scrollable modal bounds; routes were removed.

Existing UI assertions were unchanged: only their shared App import now
injects an explicit preference API. Native refactor runs passed and retain
their oracle-dependency warnings; no new native Red for those old assertions
is claimed. Japanese documentation quick diagnostics retained scores 97/100,
zero new actionable prose findings and passed final invariants. A premature
notebook invariant attempt raced formatting, was retained as blocked, and
was rerun after the completed draft was frozen. The historic notebook prefix
is byte-identical.

Live migration, actual per-user Entra/GitHub operations and publication are
separate operator boundaries; this implementation review does not authorize them.

## Extra-small text-size amendment

Approved contract SHA256:
`7b2e47dd283769799cb47e1aa55ae86c1701dabb01a884726bd87b06a7e6631e`.
The isolated SQL/CSS feasibility spikes and human approval preceded implementation.
The existing Large default and language/theme DTO remain unchanged; migration010
atomically extends the CHECK without rewriting migration008.

Direct Vitest assertion Red observed HTTP400 instead of200 and a missing fourth
option. Green passed all nine preference tests, including all16 persisted
source/target transitions. The full application typecheck/lint/test gate and
TypeScript/ESLint diagnostics passed; an isolated production build succeeded.
Restored mutations caught a CHECK rejecting extra-small (HTTP500), an omitted
selection-handler branch (missing PATCH), and an80%-instead-of70% CSS selector.
The original source was restored and the affected checks passed.

Actual-browser checks used the actual App, portal, hook and API clients with the
production JWT verifier and disposable PostgreSQL. Japanese/English options,
held-save acknowledgement-only behavior, visible503 failure and reselect retry,
new repository reads and full-reload persistence passed. Body16→11.2px and portal
14→9.8px verified70%; root16px, three pane dimensions, SVG and synthetic image/
PDF-canvas probe geometry stayed unchanged. No loaded-PDF rendering assertion is
claimed. Vite HMR was browser-blocked, so source mutations used full reloads.

Native qualification remains incomplete: `plan check --json` timed out after15s;
native `tdd red TEST-FONT-003` refused the4096-directory check-discovery budget.
Direct checks do not replace native receipts or frozen qualification. Historical
receipts/dependency fingerprints are retained, not refreshed as successful.
No live migration or publication is authorized by these results.

| ID | Severity | Evidence | State |
| --- | --- | --- | --- |
| FONT-XS-NATIVE | info | Native discovery refusal and bounded plan timeout are retained in session logs; no policy bypass or synthetic receipt. | Deferred |

Two risk-axis Claude Sonnet5.5 source reviews found no introduced storage/API or
client/CSS/test defects. Their explicitly unread spec/evidence surfaces were
not counted as reviewed: a bounded independent closure read the43-line approved
spec, complete generic hook, current amendment and actual browser JSON.
The closure completed two consecutive clean passes, with all12 frozen input
hashes matching both times. The plain503 fixture code was clarified as
`TEST_FAILURE`, not the distinct `TEXT_SIZE_UNAVAILABLE` state. No actionable
source findings remain open. No loaded-PDF or real-provider testing is claimed.
The owned fixture tab, server and disposable database were stopped; live
API/nginx stayed responsive.

Native changed gate also refused the same discovery budget, and task
verification timed out after15s. These failures remain separate from the
passing application gate. Publication requires explicit approval accepting
this qualification limitation and the brief migration-lock/API-reload risks.
