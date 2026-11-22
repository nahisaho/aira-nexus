---
feature: agent-extensions
tier: T2
approval: auto
---

# Phase 4: governed skills, MCP and agents

Goal: compose approved research tools without conflating application login with provider authentication; deferred from this delivery.

| ID                    | EARS requirement                                                                                                                                                                | Test |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| REQ-AG-001 (deferred) | When a project enables a skill, MCP server or package, the system shall allow only an administrator-approved version/source and record the enabled binding for that project.    | —    |
| REQ-AG-002 (deferred) | If a run requests ungranted external transfer or destructive access, then the system shall suspend for a scoped user approval and revalidate the exact action before execution. | —    |
| REQ-AG-003 (deferred) | When an approved backend runs, the system shall isolate its identity/workspace, normalize stream/approval/cancel events and refuse capabilities it cannot enforce.              | —    |

## Design

Mastra is a candidate for API-model orchestration, not a replacement for authorization or isolation. Vendor SDK/ACP adapters retain their agent loop; policy and artifact gateways remain application-owned.
Copilot uses documented user OAuth or approved organization server credentials; Claude uses API/provider credentials unless Anthropic grants an exception; Codex programmatic authentication requires a scoped official integration spike.

## Assumptions / risks

Dependencies: research-services, notebook-runtime. No pooled personal subscription and no shared provider-home directory. Provider availability, costs, approvals, skills/MCP parity and licensing need recorded validation before enabling each backend.
Future tests: connector identity separation, source/version revocation, OAuth refresh races, approval replay, denial propagation, cancellation and credential redaction. No external agent installed in phase 1.
