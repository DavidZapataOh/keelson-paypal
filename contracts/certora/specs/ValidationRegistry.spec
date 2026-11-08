// KeelsonValidationRegistry, linked to the real VerdictVerifier and KeelsonBondVault. No loop is unrolled
// optimistically: the hex encoding of a request hash, which only feeds the `ValidationRequest` event's URI, is
// summarized as any string.

using VerdictVerifier as verifier;
using KeelsonBondVault as vault;

methods {
    function requestOf(bytes32) external returns (bytes32) envfree;
    function validatorOf(bytes32) external returns (address) envfree;
    function agentOf(bytes32) external returns (uint256) envfree;
    function responseHashOf(bytes32) external returns (bytes32) envfree;
    function countersignStructHash(KeelsonTypes.Countersign) external returns (bytes32) envfree;
    function vault.coverages(bytes32) external returns (IKeelsonBondVault.CoverageState) envfree;

    function KeelsonValidationRegistry._hex(bytes32) internal returns (string memory) => anyString();
    // The ERC-8004 Identity registry is not in the scene: any owner and agent wallet.
    function _.ownerOf(uint256) external => NONDET;
    function _.getAgentWallet(uint256) external => NONDET;
    function _.isValidSignature(bytes32, bytes) external => NONDET;
}

function anyString() returns string {
    string s;
    require s.length == 66, "`0x` followed by 64 hex characters";
    return s;
}

definition ALLOW() returns uint8 = 1;
definition DENY() returns uint8 = 2;

// ---------------------------------------------------------------- VAL1

/// A countersign is recorded only for the digest both TEE signers (or the TDX signer alone) signed, as checked by the
/// VerdictVerifier, which is recorded as its validator.
rule recordRequiresVerifier(env e, KeelsonTypes.Countersign c, bytes sigs, bytes operatorSig) {
    bytes32 digest = verifier.hashTypedData(e, countersignStructHash(c));
    bool twoOfTwo = sigs.length == 130 && verifier.verify2of2(e, digest, sigs);
    bool degraded = sigs.length == 65 && verifier.verifyDegraded(e, digest, sigs);
    bytes32 requestHash = recordCountersign(e, c, sigs, operatorSig);
    assert requestHash == digest && (twoOfTwo || degraded);
    assert validatorOf(requestHash) == verifier;
}

rule recordRequiresVerifierReachable(env e, KeelsonTypes.Countersign c, bytes sigs, bytes operatorSig) {
    bytes32 requestHash = recordCountersign(e, c, sigs, operatorSig);
    satisfy validatorOf(requestHash) == verifier;
}

/// A request is recorded once. The only second record of the same countersign is a DENY first recorded from the TDX
/// signature alone, completed by both signatures.
rule requestOnce(env e, KeelsonTypes.Countersign c, bytes sigs1, bytes sigs2, bytes operatorSig1, bytes operatorSig2) {
    recordCountersign(e, c, sigs1, operatorSig1);
    recordCountersign@withrevert(e, c, sigs2, operatorSig2);
    assert !lastReverted => c.decision == DENY() && sigs1.length == 65 && sigs2.length == 130;
}

rule requestOnceReachable(env e, KeelsonTypes.Countersign c, bytes sigs1, bytes sigs2, bytes operatorSig1, bytes operatorSig2) {
    recordCountersign(e, c, sigs1, operatorSig1);
    recordCountersign@withrevert(e, c, sigs2, operatorSig2);
    satisfy !lastReverted;
}

/// Once recorded, a validation keeps its validator, agent and response hash, and a coverage keeps its request.
rule validationIsPermanent(env e, method f, calldataarg args, bytes32 requestHash, bytes32 coverageId) {
    address validator = validatorOf(requestHash);
    uint256 agentId = agentOf(requestHash);
    bytes32 responseHash = responseHashOf(requestHash);
    bytes32 request = requestOf(coverageId);
    f(e, args);
    assert validator != 0 => validatorOf(requestHash) == validator && agentOf(requestHash) == agentId
        && responseHashOf(requestHash) == responseHash;
    assert request != to_bytes32(0) => requestOf(coverageId) == request;
}

rule validationIsPermanentReachable(env e, method f, calldataarg args, bytes32 requestHash) filtered { f -> !f.isView } {
    require validatorOf(requestHash) == 0;
    f(e, args);
    satisfy validatorOf(requestHash) != 0;
}

// ---------------------------------------------------------------- VAL2

/// An ALLOW is recorded only for a coverage the vault holds for the same agent and amount.
rule allowImpliesCoverage(env e, KeelsonTypes.Countersign c, bytes sigs, bytes operatorSig) {
    IKeelsonBondVault.CoverageState cov = vault.coverages(c.requestId);
    bytes32 requestHash = recordCountersign(e, c, sigs, operatorSig);
    assert c.decision == ALLOW() => cov.status != IKeelsonBondVault.Status.None
        && to_mathint(cov.agentId) == to_mathint(c.agentId) && to_mathint(cov.amount) == c.amount * 10000
        && requestOf(c.requestId) == requestHash && agentOf(requestHash) == c.agentId;
}

rule allowImpliesCoverageReachable(env e, KeelsonTypes.Countersign c, bytes sigs, bytes operatorSig) {
    require c.decision == ALLOW();
    bytes32 requestHash = recordCountersign(e, c, sigs, operatorSig);
    satisfy requestOf(c.requestId) == requestHash;
}
