---
feature: identity
tier: T2
approval: human
---
# Entra identity foundation
Goal: authenticate one organization's users without server-side user credentials. Non-goals: agent credentials, app-only callers, guest sharing.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-ID-001 | When a protected API receives a bearer token, the system shall accept only a signed RS256 Entra v2 access token with the configured issuer/audience/UUID tid, UUID oid and required exp/iat/nbf/azp/scp/ver claims with 5-second clock tolerance; otherwise return 401 without token contents. | TEST-ID-001 |
| REQ-ID-002 | If a valid token lacks access_as_user or its azp is not the configured SPA, then the system shall return 403; signing-key service failures shall return 503, not authenticate the request. | TEST-ID-002 |
| REQ-ID-003 | When starting, the system shall reject missing/invalid tenant, API/SPA IDs, database URL or public origin including non-loopback HTTP; public configuration shall expose only tenant, client IDs, scope and origin, never database credentials. | TEST-ID-003 |
| REQ-ID-004 | When queried for health, the system shall return live=200 while the process serves requests and ready=200 only if PostgreSQL responds; otherwise ready shall return 503 without database details. | TEST-ID-004 |
## PASS conditions and counterexamples
| REQ | Observable PASS condition | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-ID-001` | Valid delegated identity accepted | Missing, forged, expired, wrong issuer/audience/tenant, ID-only or malformed principal rejected | TEST-ID-001 | .sdd/tdd.jsonl; unknown until recorded |
| `REQ-ID-002` | Authorized SPA/scope accepted; outages explicit | Wrong client/scope gets 403; unavailable keys get 503 | TEST-ID-002 | .sdd/tdd.jsonl; unknown until recorded |
| `REQ-ID-003` | Valid config starts and emits safe public fields | Missing settings, non-loopback HTTP or credentials in public config fail | TEST-ID-003 | .sdd/tdd.jsonl; unknown until recorded |
| `REQ-ID-004` | Healthy DB returns ready=200 | Unavailable DB returns 503 without credentials | TEST-ID-004 | .sdd/tdd.jsonl; unknown until recorded |

Risk stages: contract/inputs/execution/verdict/history/integration covered by signed-token controls and fail-closed configuration; live Entra integration remains external. Oracle: Microsoft Entra access-token validation documentation.
## Design
MSAL Browser uses PKCE, sessionStorage and explicit sign-in/out; no client secret or server token store. API requires scp (roles alone insufficient), ver=2.0 and azp=SPA ID; missing required claims is 401, insufficient scope/client is 403.
JWKS uses jose rotation with 10-minute cache, 30-second refetch cooldown and 5-second timeout; unknown keys remain unauthorized after eligible refresh, transport/invalid keyset failures return 503.
Ownership uses (tid, oid), not email or caller input. Same-origin bearer API, no cookie auth; tokens and Authorization headers are never logged. Errors carry request IDs.
## Assumptions / risks
Public Azure authority only; API registration requests v2 tokens and exposes access_as_user. Spike passed on Node 24.22.1: generated RS256 JWT, signed and verified issuer/audience/principal with installed jose. Real Entra login remains unverified until configured.
sessionStorage is script-readable: CSP and no unsafe HTML reduce but do not eliminate XSS risk. Clinical/regulated data is not approved by this specification.
