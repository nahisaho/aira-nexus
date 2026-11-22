---
feature: research-evidence
tier: T2
approval: auto
---

# Phase 5: literature, project RAG and artifact lineage

Goal: support attributable research outputs; deferred from this delivery.

| ID                     | EARS requirement                                                                                                                                                                                                           | Test |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| REQ-EVD-001 (deferred) | When answering from literature or project files, the system shall return resolvable source references and label unavailable evidence instead of fabricating citations.                                                     | —    |
| REQ-EVD-002 (deferred) | When indexing/searching project material, the system shall scope retrieval by verified owner and project before injecting retrieved text as untrusted context.                                                             | —    |
| REQ-EVD-003 (deferred) | When execution produces an artifact, the system shall link it to immutable code/input identities, execution status and available environment evidence without claiming scientific correctness or verified reproducibility. | —    |

## Design

Retrieval uses project/owner-filtered metadata and content locators; provider-specific search/embedding interfaces remain behind policy and audit controls. Code execution receipts link messages, cells and artifacts.
Literature libraries, PDF annotations, automatic rerun verification and .science interchange are excluded from the initial research-practical scope.

## Assumptions / risks

Dependencies: agent-extensions, notebook-runtime. Data classification, permitted external search services, embedding provider, citation format and document parsing limits require spikes before activation.
Future tests: cross-owner retrieval, poisoned document instructions, stale source identity, search outage and code-to-artifact linkage.
