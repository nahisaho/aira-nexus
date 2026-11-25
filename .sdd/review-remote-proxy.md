# Remote proxy review evidence

Approved specification: `.sdd/specs/remote-proxy.md`,
SHA256 `993e716f53e62eb593def9800fb993f0a045f88e25d45f9debc95ef77922a0b1`.

Machine checks before independent review: typecheck, lint, 18 tests, build and
format passed. Static diagnostics passed. Five isolated mutations were detected
by assertions and restored byte-for-byte; valid isolated control passed all four
proxy tests. Build retains dependency annotation and large-chunk warnings.

| ID          | Severity | Evidence                            | State                                                                                                       |
| ----------- | -------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| TUN-REV-001 | medium   | tests/proxy.test.ts:429             | Fixed: JSONL captures every Docker call; accepted up argv and no rejected-up calls are asserted before stop |
| TUN-REV-002 | medium   | tests/proxy.test.ts:151             | Fixed: nested finally attempts upstream, pool and directory cleanup even if Docker down fails               |
| TUN-REV-003 | low      | README.md:130                       | Fixed: split the long sentence without changing the original verification modality or JWT wording           |
| TUN-REV-004 | low      | docs/ssh-tunnel-verification.md:54  | Fixed: document the manual netstat alternative                                                              |
| TUN-REV-005 | info     | docs/ssh-tunnel-verification.md:122 | Fixed: clarify that rejected up/unhealthy does not stop existing nginx                                      |

Independent Sonnet 5.5 runtime/operator and correctness/test reviews found the
five non-blocking items above; all were addressed. Two bounded delta passes found
no remaining code or operator-document findings. The final pass actually computed
and verified all 13 frozen manifest hashes. Its pending-receipt observation is
resolved by this closure record; no manifested source changed.
The new startup-argv assertion produced an actual assertion Red for an
isolated wrong-project mutation, followed by Green after restoration.
Actual Windows SSH and
Entra SSO are unverified. The current upstream fails the loopback guard; the
proxy is not deployed against that listener.
