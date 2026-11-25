---
feature: platform-operations
tier: T2
approval: auto
---

# Phase 6: portable Kubernetes and capacity validation

Goal: qualify the service on AKS and on-premises Kubernetes; deferred from this delivery.

| ID                     | EARS requirement                                                                                                                                                                                             | Test |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| REQ-OPS-001 (deferred) | When deployed on AKS or on-premises Kubernetes, the system shall use the same application contracts with environment-specific ingress, secret, object-store and storage-class bindings.                      | —    |
| REQ-OPS-002 (deferred) | When qualifying the release, the system shall measure a representative 300-account/50-concurrent-user workload with 10GB-per-project enforcement and report observed queue/latency/failure/resource metrics. | —    |
| REQ-OPS-003 (deferred) | When operating the service, the system shall expose redacted audit/health metrics and verify backup recovery, worker recovery and least-privilege execution against agreed service objectives.               | —    |

## Design

Web/API, queue/worker and Notebook/agent pods have separate service accounts and network policy. PostgreSQL and object data are backed up independently with a tested consistency strategy.
Local Docker Compose is a developer environment, not evidence of multi-host Kubernetes qualification. TLS terminates at the controlled ingress; tenant/client configuration remains environment-specific.

## Assumptions / risks

Dependencies: research-evidence. Actual latency targets, resource sizing, RTO/RPO, retention, audit access and data classification remain unresolved production decisions, not implied guarantees.
Future tests: both target clusters, rolling upgrade, load/backpressure, pod eviction, egress policy, volume recovery and restore rehearsal.
