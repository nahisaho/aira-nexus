# Using document conversion Jobs

For researchers who already know how to select a project and upload files, this guide explains how to track conversions, request actions and open available results.

Updated: 2026-11-18. Canonical behavior: [Jobs UI specification](../.sdd/specs/conversion-job-ui.md) and [conversion specification](../.sdd/specs/document-conversion.md).

## Before opening Jobs

- Sign in and select a project you own.
- Conversion availability depends on separately approved server configuration. This guide does not enable services or authorize production activation, real-document processing, migrations or release. Development verification uses synthetic documents.
- Supported inputs are PDF, DOCX, PPTX, XLSX, PNG, JPG and JPEG, up to 25,000,000 bytes. PDF processing also has a 200-page limit.

The control names below use the English display language; Japanese labels are also available.

## Open history or request a conversion

1. Open a file's action menu in the project explorer. Existing download and trash actions remain available.
2. Select **Open jobs**. One project-scoped **Jobs** tab shows acknowledged conversion history.
3. Use **Load more jobs** when available to see older records.

To request a conversion, select **Convert** or **Reconvert** from the original file's action menu instead. Jobs opens only after the server acknowledges that request. Uploading a file never switches the active tab automatically.

The menu shows **Reconvert** when it finds earlier conversion history for that file. Wait for any upload or other file action to finish before requesting a conversion; the action is also disabled while a conversion request is pending.

## Follow a job and open its results

- Keep Jobs active to receive periodic updates. Background polling is at least one second apart and stops while the tab is inactive or closed.
- Use **Cancel** when offered to request cancellation. A running job can show **Cancellation requested** before the worker confirms its final state.
- Use **Retry** when offered for a failed or cancelled conversion whose source is still available. Duplicate submissions are blocked while a request is pending.
- Actions change the displayed job only after server acknowledgment; clicking a button alone does not establish success.
- A successful job offers actions for available Markdown and JSON results. Selecting a result opens the existing file viewer.
- Closing and reopening Jobs within the same project session retains its last acknowledged history while refreshing it.

Completion check: a successful record and its available result actions confirm that the server acknowledged completion. An output that was later trashed or permanently deleted remains unavailable without changing that historic success.

## Recover from unavailable actions or stale history

| Symptom                                                                 | Cause                                                                                      | Next action                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversion is unavailable in the file menu                              | Conversion is disabled, or the file has an unsupported extension or exceeds the size limit | Read the displayed reason. Use an eligible synthetic fixture for development verification; do not change service configuration without separate approval.  |
| An otherwise eligible file temporarily has a disabled conversion action | An upload, file action or conversion request is in progress                                | Wait for that operation to finish, then reopen the file menu.                                                                                              |
| Jobs stops updating after a visible error                               | Automatic polling stops after a failed refresh                                             | Select **Reload jobs**. The last acknowledged rows remain visible until a successful response replaces them.                                               |
| No open action appears for an output                                    | The artifact is unavailable, including after trashing or permanent deletion                | Reload Jobs to recheck availability. If it remains unavailable, request another conversion from the original file's menu when that file is still eligible. |
| Another project's history disappears after navigation                   | History and pending responses are scoped to the current account and project session        | Open Jobs from the intended project's file menu; an old project's response cannot populate the new project.                                                |
