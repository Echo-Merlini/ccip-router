# TSEI → ERC-8309 Profile A observation adapter v0

This integration maps one exact TSEI public production-grounding receipt into the signed observation
surface consumed by ERC-8309 Profile A. It is a transport/observation binding, not a new TSEI experiment and
not an additional resolution policy.

## Exact source fixture

The fixture is the already-published TSEI `-02` public receipt, copied byte-for-byte from:

- repository: `github.com/pipavlo82/crystal-receipt`
- revision: `1ee03c73a2403d72eaf8066c52cf476bba99facf`
- path: `conformance/tsei-invariant-discrimination-v0/public-receipts/tsei-ia-real-v2-20260824-02.production-grounding.json`
- bytes: `3841`
- SHA-256: `09349e8257da2b94227f7af7f8e4dcdcca9e715dc460e1f419e53a14a22e5a07`

The fixture predates the prospective `tsei.frozen-artifact -> encode-json-utf8-lf.v0` adoption boundary. It
remains historically unversioned and is **not** retroactively relabelled `.v0`. The adapter hashes its exact
bytes as an opaque public artifact; it never repairs or reserializes them.

## Mapping

- `namespace = tsei.public-production-grounding-receipt.v1`
- `inputHash = keccak256(UTF8("TSEI-PROFILE-A-OBSERVATION-v0" || 0x00 || instance_id))`
- `key = inputHash`
- `value = 0x || SHA256(exact_receipt_bytes)`
- `timestamp` is the caller's observation time and is covered by the normal ccip-router signature
- `signature` is produced by the existing `signRecord` path
- `signer` is recovered from that signature when the record is converted to a Profile A attestation
- `vantage_class = ccip-gateway-signed-receipt` identifies the observation mechanism, not independence

The shared `inputHash` makes two observations about the same TSEI instance comparable. Different exact receipt
bytes produce different values and therefore remain visible as Profile A divergence rather than being silently
collapsed.

## Claim boundary

The adapter does **not**:

- recompute TSEI private operands or re-run its production evaluator;
- interpret `authority_independently_verified` as ERC-8309 vantage independence;
- claim Profile A membership, fault tolerance, or finality;
- mint `sufficient_for_real_run` or change any status inside the receipt;
- treat a Rekor signature as a 65-byte CCIP attestation signature.

It converts exact receipt bytes into a normal signed ccip-router observation. Profile A remains the downstream
divergence-surfacing layer and resolves nothing.
