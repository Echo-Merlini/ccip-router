# ERC-8309 conformance

## spec-MUST mutation set (`spec-mutations.json`)

Every normative **MUST** in the ERC-8309 §Deduplication amendment is mapped to a code mutant the test
suite **must kill**. A green run means the spec's obligations are demonstrably *load-bearing* in this
implementation, not merely declared — the mutation gate applied as a **conformance property of the
specification itself**. A SURVIVED guard names exactly which MUST the tests only *claim* to enforce.

Run (uses the `recompute-mutation-survival` primitive from `trustless-ai/recompute-kit`):

```
recompute-kit/bin/recompute-mutation-survival \
  --dir . --test-cmd "npm test" --mutations conformance/erc-8309/spec-mutations.json
```

Expected: every guard **KILLED**, verdict **verified-good** (exit 0). CI wiring follows once
recompute-kit ships the primitive (PR #17).

## `divergence-vector.py`

Zero-dependency conformance vector for the divergence-preservation behaviour — green on `--impl current`
(the deployed bug reproduced) and `--impl amended` (the fix), RED on a regressed store.
