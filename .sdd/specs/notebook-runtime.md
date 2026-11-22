---
feature: notebook-runtime
tier: T2
approval: auto
---

# Phase 3: isolated Python/R Notebook

Goal: run AI and human analysis in project-scoped kernels; deferred from this delivery.

| ID                    | EARS requirement                                                                                                                                                                                   | Test |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| REQ-NB-001 (deferred) | When an owner executes a Python or R cell, the system shall route it to that project's isolated container/kernel and retain variable state while that kernel remains alive.                        | —    |
| REQ-NB-002 (deferred) | When an owner opens Notebook, the system shall allow cell editing/execution and persist code, outputs and execution identity without exposing another project's kernel or server token.            | —    |
| REQ-NB-003 (deferred) | If the kernel is reclaimed/restarted, then the system shall report lost in-memory state explicitly and preserve saved Notebook/code/artifacts; execution shall serialize AI and human cell writes. | —    |

## Design

Kubernetes runner controls per-project pods and storage leases; an authenticated same-origin gateway authorizes every HTTP/WebSocket request. Python/ipykernel and R/IRkernel images use pinned package sets.
No application database credentials, Docker socket, host mounts or broad cluster account inside execution pods. NetworkPolicy and non-root resource-limited pods are baseline controls, not a proof of hostile-code containment.

## Assumptions / risks

Dependencies: research-services. Kernel idle timeout, per-run CPU/memory/time limits and stronger sandbox (for example gVisor) remain spike decisions. Persistent variables do not survive pod loss.
Future tests: Python/R multi-cell state, cross-project isolation, concurrent edits, idle reclamation, blocked egress and confirmed cancellation on actual target Kubernetes.
