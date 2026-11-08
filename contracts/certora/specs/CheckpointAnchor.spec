// CheckpointAnchor, linked to the real VerdictVerifier. No loop is unrolled optimistically. Two internals are
// summarized: the signed note's text parsing (any verdict: the rules hold for any note), and the RFC 6962 consistency
// proof, replaced by an uninterpreted predicate of the two trees, so the rules prove that the anchored root passed the
// consistency check against the previous anchor; the RFC 6962 algorithm itself is bounded-checked with Halmos on trees of
// up to 16 leaves.

using VerdictVerifier as verifier;

methods {
    function rootAt(bytes32, uint64) external returns (bytes32) envfree;
    function latestSize(bytes32) external returns (uint64) envfree;
    function checkpointStructHash(bytes32, uint64, bytes32) external returns (bytes32) envfree;

    function CheckpointAnchor._noteStates(bytes32, uint64, bytes32, bytes calldata) internal returns (bool) => NONDET;
    function RFC6962.verifyConsistency(uint64 size1, uint64 size2, bytes32 root1, bytes32 root2, bytes32[] calldata) internal returns (bool) => consistent(size1, size2, root1, root2);
}

ghost consistent(uint64, uint64, bytes32, bytes32) returns bool;

// ---------------------------------------------------------------- ANC1

rule sizeStrictlyIncreases(env e, method f, calldataarg args, bytes32 origin) {
    uint64 before = latestSize(origin);
    if (f.selector == sig:anchor(bytes32, uint64, bytes32, bytes32[], bytes, bytes).selector) {
        uint64 size;
        bytes32 root;
        bytes32[] consistency;
        bytes teeSigs;
        bytes signedNote;
        anchor(e, origin, size, root, consistency, teeSigs, signedNote);
        assert latestSize(origin) == size && size > before;
    } else {
        f(e, args);
        assert latestSize(origin) >= before;
    }
}

rule sizeStrictlyIncreasesReachable(env e, bytes32 origin, uint64 size, bytes32 root, bytes32[] consistency, bytes teeSigs, bytes signedNote) {
    require latestSize(origin) > 0;
    anchor(e, origin, size, root, consistency, teeSigs, signedNote);
    satisfy latestSize(origin) == size;
}

// ---------------------------------------------------------------- ANC2

rule rootWrittenOnce(env e, method f, calldataarg args, bytes32 origin, uint64 size) {
    bytes32 before = rootAt(origin, size);
    f(e, args);
    assert before != to_bytes32(0) => rootAt(origin, size) == before;
}

rule rootWrittenOnceReachable(env e, method f, calldataarg args, bytes32 origin, uint64 size) filtered { f -> !f.isView } {
    require rootAt(origin, size) == to_bytes32(0);
    f(e, args);
    satisfy rootAt(origin, size) != to_bytes32(0);
}

// ---------------------------------------------------------------- ANC3

rule anchorRequires2of2(env e, bytes32 origin, uint64 size, bytes32 root, bytes32[] consistency, bytes teeSigs, bytes signedNote) {
    bytes32 digest = verifier.hashTypedData(e, checkpointStructHash(origin, size, root));
    bool signed = verifier.verify2of2(e, digest, teeSigs);
    anchor(e, origin, size, root, consistency, teeSigs, signedNote);
    assert signed;
}

rule anchorRequires2of2Reachable(env e, bytes32 origin, uint64 size, bytes32 root, bytes32[] consistency, bytes teeSigs, bytes signedNote) {
    anchor(e, origin, size, root, consistency, teeSigs, signedNote);
    satisfy rootAt(origin, size) == root;
}

/// The first anchor of an origin takes no proof; every later one stores a root the consistency check accepted against
/// the latest anchored root.
rule anchorChecksConsistency(env e, bytes32 origin, uint64 size, bytes32 root, bytes32[] consistency, bytes teeSigs, bytes signedNote) {
    uint64 last = latestSize(origin);
    bytes32 lastRoot = rootAt(origin, last);
    anchor(e, origin, size, root, consistency, teeSigs, signedNote);
    assert last == 0 => consistency.length == 0;
    assert last != 0 => consistency.length <= 65 && consistent(last, size, lastRoot, root);
}

rule anchorChecksConsistencyReachable(env e, bytes32 origin, uint64 size, bytes32 root, bytes32[] consistency, bytes teeSigs, bytes signedNote) {
    require latestSize(origin) != 0;
    anchor(e, origin, size, root, consistency, teeSigs, signedNote);
    satisfy true;
}
