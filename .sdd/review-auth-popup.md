# Popup callback review evidence

Approved specification: `.sdd/specs/auth-popup.md`,
SHA256 `c94495595fc4f880110f0714758f97b148671da57c8a9d6b7d3b9b87ce321ff5`.
Human approval explicitly permits only the successful exact GET/HEAD callback
COOP exception and isolated implementation/validation, not existing-service
restarts, real environment edits or tenant changes.

The synthetic Chromium spike reproduced the severed popup connection under
same-origin-allow-popups and preserved it under unsafe-none. Independent Sonnet
5.5 design reviews, including the final narrowed design delta, found no blockers.
Dot-segment normalization happens before pathname matching; rejecting an
indistinguishable raw path is not a requirement. Same-origin policy is unchanged.

Machine checks before implementation review: expected assertion Red then native
Green for TEST-POP-001; six related identity, popup and browser-auth regressions;
TypeScript/ESLint diagnostics, build and formatting passed. The three isolated
path-substring, missing-method and missing-status mutations failed by assertion,
then the copied application was restored byte-for-byte. No live source mutation
was used. Dependency annotation and large-chunk build warnings remain.

Both operator guides have zero structural and GiNZA prose findings (100 before
and after). Authorized technical changes are retained separately from the frozen
post-update drafts used for prose invariants; no optional prose rewrite was
needed. Both invariant checks passed with identical draft/final hashes.
Japanese prose optimization completed.

| ID | Severity | Evidence | State |
| --- | --- | --- | --- |

Independent Sonnet 5.5 policy/correctness and test/operator-contract reviews
returned no findings. Six distinct source hashes were actually checked across
the two reviewers; configuration/plan are machine-validated separately. All
19 regression tests subsequently passed. Fresh native verification receipts were
obtained and adopted in prerequisite order for all five active tasks.
The full native gate passed: 19/19 Red-to-Green tests, trace, ledger, planning,
typecheck, lint, test, build and format. The existing identity implementation
re-review warning remains; no human reapproval was fabricated.
The final bounded review computed and verified all eight final manifest hashes
and ran native plan check: PASS with all five tasks complete. Only the
implementation plan changed since the clean risk reviews; the seven other
manifested sources are byte-identical. This was the second consecutive clean
round. Its scope was hash comparison and native plan consistency, not a manual
re-review of receipt fields, this ledger, the gate log or the notebook.
The restored isolated mutation control also passed before removal of its exact
scratch directory; mutation logs and immutable review evidence were retained.
Real Windows/Entra retest, hidden-iframe renewal and owner-controlled application
restart remain unverified; no actual authentication code was stored in evidence.
