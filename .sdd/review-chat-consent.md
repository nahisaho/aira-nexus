# Chat consent review ledger

## Round 1 (base unavailable: repository files are untracked)

CHC-COR-01 | HIGH | src/server/chat/repository.ts:478 | Preview admission stored the full serialized transcript as the user turn; now stores the final user text | Fixed
CHC-COR-02 | MED | db/migrations/015_chat_consent.sql:29 | Preview omitted the project-version binding; now captured and checked during admission | Fixed
CHC-SEC-01 | LOW | src/server/chat/worker.ts:50 | Credential replacement during an in-flight generation does not trigger abort within five seconds | Open
CHC-COR-03 | LOW | src/server/chat/repository.ts:778 | Legacy preview-less admissions fail closed at dispatch; no public route uses legacy admission | Rejected: legacy admission is not exposed by HTTP and dispatch prevents any provider request without a preview binding
CHC-TEST-01 | MED | src/server/chat/routes.ts:77 | Route-level API contract lacks direct tests | Open
CHC-TEST-02 | MED | src/server/chat/consent.ts:169 | Expiry equality and expiry-minus-one-millisecond cases lack tests | Open
CHC-TEST-03 | MED | src/server/chat/consent.ts:198 | Snapshot-size and oversized-body boundary cases lack tests | Open
CHC-TEST-04 | LOW | src/server/chat/consent.ts:267 | Provider discovery failure and invalid-inventory paths lack tests | Open
CHC-DOC-01 | LOW | docs/chat.md:94 | Spec allows sanitized 502/503 while implementation returns 503 | Rejected: 503 is permitted by the approved spec and matches the documentation

## Round 2

CHC-SEC-01 | LOW | src/server/chat/worker.ts:52 | Generation checks the credential binding on a five-second timer and again before answer persistence; disconnect during a synthetic SDK request triggers abort without storing an answer | Fixed

## Round 3

CHC-TEST-01 | MED | tests/chat-consent.test.ts | Authenticated HTTP tests cover strict bodies, content type, no-store, status codes, the idempotency header and missing-project precedence | Fixed
CHC-TEST-02 | MED | tests/chat-consent.test.ts | A fixed PostgreSQL clock proves equality rejection and one-millisecond remaining validity for previews and model catalogs; accepting catalog equality makes the test fail | Fixed
CHC-TEST-03 | MED | tests/chat-consent.test.ts | Tests accept 16384-byte bodies and 262144-byte snapshots, and reject each limit plus one byte | Fixed
CHC-TEST-04 | LOW | tests/chat-consent.test.ts | Synthetic discovery failures and invalid inventory return sanitized 503, and connection loss during discovery prevents catalog persistence | Fixed
