---
feature: notebook-runtime
tier: T2
approval: human
---
# Phase 3: isolated Python/R Notebook
Goal: provide project owners with editable, persistent Python and R analysis in isolated Kubernetes kernels.

| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-NB-001 | When an owner runs a Python or R cell, the system shall execute it in that project's language-specific kernel, retain variables only while that kernel lives, and serialize cells per kernel; Python and R states shall remain separate. | TEST-NB-001 |
| REQ-NB-002 | When an owner opens Notebook, the system shall allow editing and execution, persist code/output/execution identity, authorize every same-origin HTTP/WebSocket request by tenant and owner, and never expose kernel credentials to the browser. Selected files resolve only by owner/project-bound file IDs, are read-only, and total at most 268435456 staged bytes; artifacts use validated basenames and existing project file limits/storage, never caller paths. | TEST-NB-002, TEST-NB-006, TEST-NB-007 |
| REQ-NB-003 | If a kernel is reclaimed, times out, is idle-stopped, or its project is trashed, then the system shall stop/remove its runtime and report lost variables while preserving saved code, outputs and artifacts; restore starts fresh. Concurrent human/AI cell writes shall serialize and stale writes shall not overwrite newer cells. | TEST-NB-003 |
| REQ-NB-004 | When NOTEBOOK_ENABLED is absent or false, the system shall register no Notebook execution handler; when true, it shall expose only fixed internal notebook.execute through Notebook API and require Kata plus verified default-deny policy allowing kernel ingress only from gateway namespace/pod labels aira.nexus/role=notebook-gateway and aira.nexus/component=notebook-gateway. Missing Kata or verified NetworkPolicy enforcement shall fail closed; generic jobs, shell commands and kernel egress remain forbidden. | TEST-NB-004 |
| REQ-NB-005 | When a cell runs, the system shall cap code at 262144 bytes, output at 8388608 bytes per cell, CPU at 1 core, memory at 2 GiB and execution at 120 seconds; timeout shall kill/restart that kernel and report state loss. It shall allow at most one kernel per language/project, two per project and eight cluster-wide; kernels idle for 900 seconds shall stop and report state loss. | TEST-NB-005, TEST-NB-008 |

## PASS conditions and counterexamples
| REQ | PASS | Counterexample |
| --- | --- | --- |
| `REQ-NB-001` | Python and R preserve their own multi-cell state; another project's kernel cannot read it. | Cross-project variable or file access succeeds. |
| `REQ-NB-002` | Owner checks cover HTTP/WebSocket; file IDs cannot cross projects; staged bytes and artifact names/quotas are bounded. | Foreign ID, caller path, over-limit staging or project escape succeeds. |
| `REQ-NB-003` | Restart, timeout, idle stop and project trash report state loss; saved content/artifacts remain; racing writes serialize and stale versions conflict. | A trashed project keeps an executable kernel or stale writes overwrite newer cells. |
| `REQ-NB-004` | Disabled mode makes no kernel/job-schema calls; enabled pods use Kata and verified deny-by-default policy with gateway-only ingress. | Missing runtime/policy enforcement still starts a kernel, or unapproved egress works. |
| `REQ-NB-005` | Inputs/outputs meet byte caps; excess is rejected or explicitly truncated; timed-out kernels restart; concurrency and idle limits hold. | Unbounded input/output/resources, surviving timed-out code or excess kernels succeed. |

## Design
- API/worker and authenticated same-origin gateway run in-cluster; one namespace per project contains separate Python/R kernels. Jupyter Server provides ipykernel/IRkernel; its internal token remains server-side and terminal/file-browser APIs are disabled. Every HTTP/WebSocket call is owner-checked.
- Each kernel requires RuntimeClass `kata`, no service-account token, non-root UID, no privilege escalation, read-only root, all capabilities dropped, RuntimeDefault seccomp, CPU/memory limits and default-deny policy; only the labeled in-cluster gateway may connect to kernels, which have no egress. Admission caps kernels at eight cluster-wide and two per project.
- Notebook code/output/identity persist in PostgreSQL; selected files are staged read-only and artifacts use existing project storage. Kernel pods receive no DB, Blob or cluster credentials.
- This is the only separately human-approved exception to `REQ-SVC-014`'s default Python/R prohibition. No generic job admission, arbitrary commands, package installation or external network access is added.

## Assumptions / risks
- One Notebook per project; at most one kernel per language, with independent Python/R state. Package sets are image-pinned; runtime package installation is unavailable.
- One Notebook per project and at most one kernel per language are assumed. The verified test node has 12 allocatable CPUs and 64168412 KiB memory; an eight-kernel cap leaves four CPUs for other services. A load test at the cap will retire this sizing assumption.
- A disposable Kind v1.37.0 cluster passed cross-namespace default-deny and hardened-pod probes; both `gvisor` and `kata` RuntimeClasses passed a non-root probe. The pinned x86_64 image `quay.io/jupyter/r-notebook@sha256:95282ae540ecb3260014841ff2f6edafe8543e9c3816a52988a08eab7d53bb39` ran `python3` and `ir` kernels under Kata, read-only root, non-root UID, seccomp, dropped capabilities, no service token and deny-all networking; both retained state across cells. Only Kata is selected. Production CNI/runtime equivalence remains unverified; no hostile-code containment guarantee is claimed.
- The 268435456-byte staging cap is a conservative default for 2-GiB kernels; TEST-NB-007 verifies aggregate accounting, path isolation and the existing per-file/project quotas. Project trash removes the ephemeral namespace; restore creates a fresh runtime. Verify cleanup against the project-management lifecycle during the cluster integration test.
- Cell/output/resource/idle limits above are conservative initial policy. Gateway authorization/routing, read-only file staging, artifact persistence, cancellation, expiry and restart behavior remain to be verified before completion.
- In-cluster API/worker verification uses a disposable PostgreSQL database; no live project database, production credential or migration is in scope.
