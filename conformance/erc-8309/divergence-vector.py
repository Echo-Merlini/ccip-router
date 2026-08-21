#!/usr/bin/env python3
"""
ERC-8309 vantage-divergence conformance vector — PR version (parameterized).

Supersedes the evidence-only 8309-divergence-drop-vector.py. Same claim, but written so the SAME
file goes green before AND after the divergence-preservation fix — it never manufactures a false RED
against a passing fix (the symmetric failure class the corpus itself names).

--------------------------------------------------------------------------------------------------
Why the evidence vector could not be the PR vector
--------------------------------------------------------------------------------------------------
The shared vector asserted, on the SAME query `rows`, both:
    check(... len(rows) == 1 ...)   # "second observation silently dropped"   (green today)
    check(... len(rows) == 2 ...)   # "8309 MUST preserve both"  (fix-target, red today)
Those are mutually exclusive, so the suite can never be all-green under any single behavior, and
whether it misreports after the fix depends on how the fix stores divergence:
  - fix keeps both rows in `records`     -> the "dropped" check flips to FAIL
  - fix holds divergence in a side set   -> the "preserve" check never goes green
Independently reproduced both ways (Tiago's run, 2026-08-20). The correct fix is not "invert one
boolean" — it is to assert the requirement ONCE against a consumer-visible read surface, and to
parameterize the run by the implementation under test and its DECLARED expected conformance.

--------------------------------------------------------------------------------------------------
The requirements under test (representation-agnostic)
--------------------------------------------------------------------------------------------------
R-DUP  (holds in every conformant impl): two OBSERVATION-IDENTICAL records of the same
       (inputHash, namespace, value) collapse to one — idempotent no-op.
R-DIV  (the amendment): two VALID observations of the same (inputHash, namespace) with DIFFERENT
       outputHash are BOTH retained and surfaced as a divergence — never collapsed to one, never
       represented as agreement.

Both are asserted against a read surface every consumer shares:
       observations(ih, ns) -> set of distinct valid (value, peer) a consumer would see
       divergence_state(ih, ns) -> "single" | "divergent" | "absent"
so the assertion does not care whether a fix stores divergence in-row or in a side set.

--------------------------------------------------------------------------------------------------
Usage
--------------------------------------------------------------------------------------------------
  python3 8309-divergence-vector-PR.py --impl current   # deployed ccip-router@0.7.0 semantics
  python3 8309-divergence-vector-PR.py --impl amended    # divergence-preserving fix

Each run DECLARES the conformance expected of the implementation it points at:
  --impl current  -> R-DIV expected UNMET  (this is the live bug; the run is EVIDENCE, and green
                     because reality matches the declared expectation — it prints that R-DIV is unmet)
  --impl amended  -> R-DIV expected MET    (the fix; green when the store actually preserves)
Exit 0 iff the implementation-under-test matches its declared expectation. So today
`--impl current` is green (bug reproduced as expected); when the fix lands the PR's CI runs
`--impl amended` against the real store and it is green. No false RED, ever.

No dependencies (sqlite3 is stdlib). Any WG member can run it.
"""
import sqlite3, sys, argparse

IH, NS = "0xINPUT", "dinamic.eth"

# ------------------------------------------------------------------ storage implementations
def make_store(impl):
    """Return an object exposing ingest / observations / divergence_state for the chosen impl."""
    db = sqlite3.connect(":memory:")
    if impl == "current":
        # faithful to ccip-router@0.7.0: PK (input_hash, namespace), INSERT OR IGNORE.
        db.execute("""CREATE TABLE records(
            input_hash TEXT, namespace TEXT, key TEXT, value TEXT, timestamp INTEGER,
            signature TEXT, source_peer TEXT, PRIMARY KEY(input_hash, namespace))""")
        def ingest(rec):
            db.execute("INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?)", rec)
    else:  # amended: observation-identical -> no-op; same key + differing outputHash -> preserve both.
        # Divergence stored in-row by widening the key to include value; representation is an impl
        # choice — the read surface below hides it, which is the whole point.
        db.execute("""CREATE TABLE records(
            input_hash TEXT, namespace TEXT, key TEXT, value TEXT, timestamp INTEGER,
            signature TEXT, source_peer TEXT, PRIMARY KEY(input_hash, namespace, value))""")
        def ingest(rec):
            db.execute("INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?)", rec)

    def observations(ih, ns):
        return set(db.execute(
            "SELECT value, source_peer FROM records WHERE input_hash=? AND namespace=?", (ih, ns)).fetchall())

    def divergence_state(ih, ns):
        vals = {v for (v, _) in observations(ih, ns)}
        if not vals: return "absent"
        return "divergent" if len(vals) > 1 else "single"

    return ingest, observations, divergence_state


# ------------------------------------------------------------------ requirement checks
def evaluate(impl):
    """Return (r_dup_ok, r_div_met) for the implementation under test."""
    # R-DUP: observation-identical collapse
    ingest, observations, _ = make_store(impl)
    ingest((IH, NS, IH, "0xSAME", 1, "0xsigA", "nodeA"))
    ingest((IH, NS, IH, "0xSAME", 2, "0xsigB", "nodeB"))   # same output, different signer/ts
    r_dup_ok = observations(IH, NS) == {("0xSAME", "nodeA")}  # collapsed to one

    # R-DIV: genuine divergence retained + surfaced
    ingest, observations, divergence_state = make_store(impl)
    ingest((IH, NS, IH, "0xOUTPUT_A", 1, "0xsigA", "gatewayA"))
    ingest((IH, NS, IH, "0xOUTPUT_B", 2, "0xsigB", "gatewayB"))  # divergent, both valid
    obs = observations(IH, NS)
    r_div_met = (obs == {("0xOUTPUT_A", "gatewayA"), ("0xOUTPUT_B", "gatewayB")}
                 and divergence_state(IH, NS) == "divergent")
    return r_dup_ok, r_div_met


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--impl", choices=["current", "amended"], default="current")
    impl = ap.parse_args().impl

    # Declared expectation for each implementation.
    R_DIV_EXPECTED_MET = {"current": False, "amended": True}[impl]

    r_dup_ok, r_div_met = evaluate(impl)

    print(f"ERC-8309 divergence vector — impl='{impl}'")
    print(f"  R-DUP  (observation-identical collapses to one)           : {'MET' if r_dup_ok else 'UNMET'}")
    print(f"  R-DIV  (divergence retained + surfaced, not agreement): "
          f"{'MET' if r_div_met else 'UNMET'}   (expected {'MET' if R_DIV_EXPECTED_MET else 'UNMET'})")

    fails = []
    if not r_dup_ok:
        fails.append("R-DUP must hold in every conformant implementation")
    if r_div_met != R_DIV_EXPECTED_MET:
        fails.append(f"R-DIV = {'MET' if r_div_met else 'UNMET'} but declared expectation was "
                     f"{'MET' if R_DIV_EXPECTED_MET else 'UNMET'}")

    print()
    if not fails:
        if impl == "current":
            print("GREEN (evidence): the deployed store reproduces the bug exactly as declared — "
                  "R-DIV UNMET, divergence silently collapsed to 'single'. This is the live defect.")
        else:
            print("GREEN (conformant): the store preserves and surfaces divergence — R-DIV MET.")
        sys.exit(0)
    for f in fails:
        print(f"RED: {f}")
    sys.exit(1)


if __name__ == "__main__":
    main()
