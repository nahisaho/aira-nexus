# Identity specification review
Spec sha256: af219aa84624f12b43eef036fd9644a4e4f3ae0c998598af6f8c9e8cd5cf53ab
R-ID-01|medium|.sdd/specs/identity.md:10|Resolved: claims, clock tolerance, scope/client, outage and key-cache policy made explicit.
R-ID-02|medium|.sdd/specs/identity.md:13|Resolved: readiness has its own requirement/test and does not imply live SSO.
Residual: live Entra app setup and XSS exposure of browser token cache require operator acceptance; human approval pending.

2026-11-12 execution update: the user approved the saved prompt, and the exact identity spec lock is recorded in approvals.json. Claude Sonnet 5.5 reviewed the nine fixed server-manifest files after machine validation: no significant findings. The earlier pending-approval sentence records the pre-implementation state, not the current approval status. Real Entra SSO remains unverified.
