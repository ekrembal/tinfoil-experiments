# Official V3 verifier snapshot

Unmodified `packages/verifier/src` and LICENSE from https://github.com/tinfoilsh/tinfoil-node at commit `f052c4cc7372d7e31f9ce86f2d0e7462939c09a3` (2.0.0-rc.1). Apache-2.0. Local tsconfig only builds this snapshot. The published 1.4.0 JS SDK supports inference verification but **not** the V3 nonce/key documents returned by the container socket. This separate official verifier handles those; it is not a custom attestation implementation. No network I/O occurs in V3 verification.
