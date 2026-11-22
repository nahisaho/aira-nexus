---
feature: conversion-job-ui
tier: T2
approval: auto
---
# Central conversion jobs tab
Goal: expose acknowledged document-conversion requests in the existing3-pane workspace. Depends on document-conversion; never enable live workers or add chat/model execution.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-CJU-001 | When a user opens Jobs from the file menu or a successful manual conversion request, the system shall activate one central Jobs tab for the current project without losing existing file tabs, selection or pane widths; automatic upload conversion shall not steal focus or switch the active tab, and completed artifact links shall open the existing verified file viewer. | TEST-CJU-001 |
| REQ-CJU-002 | When the Jobs tab is active, it shall show acknowledged paginated requests with source name, waiting/queued/running/cancel-requested/succeeded/failed/cancelled state, safe localized failure reason, cancel/retry and available successful Markdown/JSON links; trashed/purged outputs show localized unavailable status without an open action or changing historic success, invented percentages/status are forbidden, and pending actions prevent conflicting writes until acknowledged. | TEST-CJU-002 |
| REQ-CJU-003 | When an eligible active file's menu opens, it shall offer Convert or Reconvert and Open jobs while retaining existing download/trash/menu/keyboard behavior; disabled, oversized or unsupported conversion shall show an explicit reason without disabling the original file operations or issuing a conversion request. | TEST-CJU-003 |
| REQ-CJU-004 | While conversion state loads/polls/writes, the client shall strictly validate safe responses, use authorizedFetch and server idempotency, expose retryable failures without optimistic persistence, stop polling inactive tabs and abort/discard old owner/project/epoch results including same-turn401;503/unavailable is explicit and current401 follows the existing sign-in reset. | TEST-CJU-004 |
| REQ-CJU-005 | When language/theme/text size changes or the Jobs tab is closed/reopened, the system shall preserve current project/file context and acknowledged requests, translate UI labels/errors without translating user filenames, support accessible keyboard/focus/cancel/retry controls and existing typography tokens, and never persist identity/job state in browser storage. | TEST-CJU-005 |
## Design
One project/session-scoped conversion API adapter and Jobs panel reuse WorkspaceTabs, existing auth fences, Radix controls and Japanese/English catalog. File menu callbacks open that same tab; no parallel explorer/dialog framework or second job state machine is added.
Active-panel polling is abortable, bounded to one in-flight request and no faster than1second; inactive/closed/logout stops it. Snapshot display remains acknowledged while writes/polls are pending, and stale responses cannot affect the next scope.
Local UI states are loading, ready, writing, unavailable and failed; error retry restores only server-confirmed data. Cancel-requested remains distinct from confirmed cancelled, and terminal Retry creates a fresh request while preserving earlier artifacts/history.
## PASS conditions and counterexamples
`REQ-CJU-001`..`REQ-CJU-005`: real upload→waiting→job→paired-artifact controls, menu/keyboard/tab/focus preservation, bounded active-only polling and auth/project/epoch fences; reject false success, stale401 resets, duplicate writes, leaked prior-owner rows, hidden errors and optimistic cancellation.
## Assumptions / risks
Confirmed: central Jobs tab, accessible from file menus. Defaults: progress uses states rather than fabricated percentages; unknown/new server states fail response validation visibly; no background-tab polling or automatic navigation on uploads.
Browser validation uses synthetic JWTs/documents with disposable PostgreSQL/Azurite and the actual isolated converter; live Entra/Azure, deployment activation and chat remain separate.
