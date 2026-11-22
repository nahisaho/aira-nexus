---
feature: auth-popup
tier: T2
approval: human
---
# Preserve the MSAL v4 popup callback connection
Goal: let the opener consume a completed popup authorization response without weakening API authentication.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-POP-001 | When serving HTTP 200 for GET or HEAD on the exact parsed path /auth-redirect.html (with or without a query), the system shall return Cross-Origin-Opener-Policy: unsafe-none; all other paths, methods and statuses shall retain same-origin-allow-popups, and existing CSP, no-store, nosniff, blank callback content and bearer-token validation shall remain unchanged. | TEST-POP-001 |
## Design
Keep the existing strict default and override COOP after routing only for a successful callback GET/HEAD. Match the parsed pathname, not substrings; standard URL dot-segment normalization happens before this check. Do not change nginx, MSAL versions, Entra registration, token checks or the empty callback HTML.
Add tests/popup.test.ts with the actual static-file callback handler and positive GET/HEAD/query plus negative case/suffix/prefix/trailing-slash/encoded-path, POST/PUT/OPTIONS and missing-callback 404 controls. Check the unchanged callback headers/content and API 401. Static conditional caching/ETags are not added. Update only callback-header explanations in docs/entra-sso-verification.md and docs/ssh-tunnel-verification.md.
Dependencies: identity, workbench, remote-proxy. Keep existing services and real .env untouched; the owner restarts the running application after build.
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | Test/evidence |
| --- | --- | --- | --- |
| `REQ-POP-001` | Callback GET/HEAD stays linked to opener; normal pages/API keep their policy and unauthenticated API stays 401 | Existing callback policy severs the opener; broad unsafe-none or path-substring matching weakens other endpoints | TEST-POP-001; isolated real-browser spike |
## Assumptions / risks
The exception deliberately relaxes browsing-context isolation only for the existing empty callback on GET/HEAD; same-origin rules, CSP and API authorization are not relaxed. Hidden-iframe renewal policy and MSAL upgrades are outside this popup fix.
Spike: isolated Chromium contexts with synthetic HTTPS app/identity-provider routes reproduced closed=true, unreadable callback and lost opener for callback same-origin-allow-popups; unsafe-none preserved the readable synthetic fragment and opener. Both contexts were closed; no real authentication code was used or retained.
MSAL 4.30.0 source confirms monitorPopupForHash rejects userCancelled when the WindowProxy reports closed: https://raw.githubusercontent.com/AzureAD/microsoft-authentication-library-for-js/msal-browser-v4.30.0/lib/msal-browser/src/interaction_client/PopupClient.ts .
The browser spike is external evidence, not a CI browser test; actual Windows/Entra retest remains manual. Rollback removes this exception and requires owner-controlled rebuild/restart, possibly restoring the sign-in failure. This approval is limited to implementation and isolated validation, not restarting existing services or changing tenant/security policy elsewhere.
