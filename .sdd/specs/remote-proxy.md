---
feature: remote-proxy
tier: T2
approval: human
---

# SSH-only development reverse proxy

Goal: Windows browser HTTP on localhost:5173 reaches Docker nginx and host Node.js over an existing SSH connection; no direct remote HTTP, TLS deployment or Kubernetes activation.

| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-TUN-001 | When nginx receives a request on 127.0.0.1:18080, the system shall proxy it to literal 127.0.0.1:3000 while preserving Host, method, path/query, body, Authorization, If-Match, response status/body and application security headers, including unauthenticated 401; forwarded-address headers shall be overwritten from the connection and access logs shall contain only response status, never method, URI, query, headers or body. | TEST-TUN-001 |
| REQ-TUN-002 | When BIND_HOST is explicitly 127.0.0.1, the system shall bind Node.js only to that address; if it is any other explicit value, startup shall fail without disclosing configuration; if absent, the existing 0.0.0.0 binding shall remain unchanged and startup shall emit a generic non-loopback warning without configuration values. | TEST-TUN-002 |
| REQ-TUN-003 | When the proxy launcher is invoked, the system shall reject unknown actions and refuse startup unless every TCP listener on port 3000 is 127.0.0.1 with at least one listener; its stop action shall stop only its own nginx service, never DB, SSH or other host services. | TEST-TUN-003 |
| REQ-TUN-004 | When the proxy Compose service runs on Linux, the system shall use a digest-pinned nginx image, host networking with nginx listening only on 127.0.0.1:18080, a non-root user, read-only root/config, dropped capabilities, no-new-privileges and bounded writable tmpfs; its health check shall return nonzero for missing/unsafe port-3000 listeners or failed upstream liveness. | TEST-TUN-004 |

## Design

Windows OpenSSH forwards 127.0.0.1:5173 to Linux 127.0.0.1:18080; browser origin and Entra SPA redirect remain http://localhost:5173 and /auth-redirect.html. Docker nginx uses Linux host networking to reach host Node.js; existing DB Compose remains separate and unchanged.
Add compose.proxy.yml, nginx/tunnel.conf, scripts/proxy.sh, scripts/check-loopback.sh, tests/proxy.test.ts and docs/ssh-tunnel-verification.md; minimally extend src/server/config.ts and index.ts, .env.example, package.json, README.md and docs/entra-sso-verification.md (SSH guidance and localhost port-only URI duplication correction). The launcher owns the nginx configuration/runtime contract; a shared socket-policy helper runs on host and in health checks; tests inspect actual nginx and Node listeners.
Policy: scan all TCP families; no exact port-3000 match, public/mixed/IPv6/mapped listeners, unavailable/failed socket tooling and unknown actions reject; only literal 127.0.0.1:3000 accepts; port 30000 never matches. Stop targets only the dedicated proxy project. No SSH daemon, firewall, existing process or real .env edits are authorized.

## Assumptions / risks

Dependencies: identity. Existing SSH access/forwarding and Windows port 5173 availability are operator prerequisites; real Windows SSH and Entra SSO remain manual/unverified. Binding checks are point-in-time; later unsafe rebind makes health fail, not permission to stop host services. The host is trusted and existing Node must be manually restarted with BIND_HOST=127.0.0.1; absent preserves public legacy binding. No release/publish/commit/push.
Spike: nginx 1.30.6 digest sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311 passed actual host-network loopback forwarding with non-root/read-only/cap-drop; initial cache-tmpfs permission failure was corrected using private mode-1777 tmpfs. Task-owned spike container/files were removed; existing services were unchanged.
PASS/counterexamples: `REQ-TUN-001` forwards valid requests/401, rejects stripped bearer/precondition or altered status; `REQ-TUN-002` binds loopback and rejects invalid input, with legacy control; `REQ-TUN-003` covers every listener/action policy row; `REQ-TUN-004` inspects actual runtime restrictions, fails on wildcard binding or weakened isolation. Native Red/Green, isolated restored mutations and full gate are required before completion.
