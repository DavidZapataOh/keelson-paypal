// VerdictVerifier. The attestation verifiers (Automata DCAP, on-chain or RISC Zero, and Base's NitroValidator) are
// external and summarized NONDET: the rules prove what the registry does with any attestation result, not that those
// verifiers are correct, which their own audits cover. No loop is unrolled optimistically: the attestation parsers, the
// RTMR3 replay and the measurement derivation (loops over the runtime events and SHA-384) return arbitrary values, so
// registration is checked for any parsed attestation. Hashes of attestation fields are assumed to fit the Prover's
// hashing bound (`optimistic_hashing`); real fields are 32 to 64 bytes. The AccessManager's decision is abstracted at
// OpenZeppelin's `AccessManaged._checkCanCall`: the rules prove that a governance change happens only once the authority
// approved the caller; which role and delay the deployed authority requires is read from the live chains.

methods {
    function issuer() external returns (bytes32) envfree;
    function allowedMeasurement(bytes32) external returns (bool) envfree;
    function measurementId(bytes32) external returns (uint64) envfree;
    function allowedId(uint64) external returns (bool) envfree;
    function signerMeasurementId(address) external returns (uint64) envfree;
    function signers(address) external returns (uint8, uint40, uint40, uint40, bytes32) envfree;
    function recover(bytes32, bytes) external returns (address) envfree;
    function recoverPart(bytes32, bytes, uint256) external returns (address) envfree;

    function _.verifyAndAttestOnChain(bytes) external => NONDET;
    function _.verifyAndAttestWithZKProof(bytes, uint8, bytes) external => NONDET;
    function _.validateAttestationWithHints(bytes, bytes, bytes) external => NONDET;
    // Arbitrum's ArbSys precompile: any current L2 block number.
    function _.arbBlockNumber() external => NONDET;
    function DstackEvents.replay(DstackEvents.RuntimeEvent[] calldata) internal returns (bytes memory) => anyBytes();
    function DstackEvents.tdxMeasurement(bytes memory, bytes memory, bytes memory, bytes memory, DstackEvents.RuntimeEvent[] calldata) internal returns (bytes32) => NONDET;
    function TdxOutput.parse(bytes memory) internal returns (TdxOutput.Td10 memory) => anyTd10();
    function NitroDocument.read(bytes memory, INitroValidator.Ptrs memory) internal returns (NitroDocument.Fields memory) => anyNitroFields();
    // The authority approves or refuses the caller (at once, or by consuming an operation scheduled past its delay).
    function AccessManaged._checkCanCall(address caller, bytes calldata) internal => checkCanCall(caller);
}

function anyBytes() returns bytes {
    bytes b;
    return b;
}

function anyTd10() returns TdxOutput.Td10 {
    TdxOutput.Td10 td;
    return td;
}

function anyNitroFields() returns NitroDocument.Fields {
    NitroDocument.Fields f;
    return f;
}

ghost bool authorityApproved;
ghost address approvedCaller;

function checkCanCall(address caller) {
    bool approved;
    if (!approved) {
        revert("AccessManagedUnauthorized");
    }
    authorityApproved = true;
    approvedCaller = caller;
}

definition TDX() returns uint8 = 1;
definition NITRO() returns uint8 = 2;

definition isRegistration(method f) returns bool =
    f.selector == sig:registerSignerWithQuote(bytes, DstackEvents.RuntimeEvent[], IVerdictVerifier.SignerBinding, uint256).selector
    || f.selector == sig:registerSignerWithZkQuote(bytes, bytes, DstackEvents.RuntimeEvent[], IVerdictVerifier.SignerBinding, uint256).selector
    || f.selector == sig:registerSignerWithNitro(bytes, bytes, bytes, IVerdictVerifier.SignerBinding, uint256).selector;

function expiresAtOf(address s) returns uint40 {
    uint8 kind; uint40 registeredAt; uint40 expiresAt; uint40 revokedAt; bytes32 measurement;
    kind, registeredAt, expiresAt, revokedAt, measurement = signers(s);
    return expiresAt;
}

function revokedAtOf(address s) returns uint40 {
    uint8 kind; uint40 registeredAt; uint40 expiresAt; uint40 revokedAt; bytes32 measurement;
    kind, registeredAt, expiresAt, revokedAt, measurement = signers(s);
    return revokedAt;
}

function measurementOf(address s) returns bytes32 {
    uint8 kind; uint40 registeredAt; uint40 expiresAt; uint40 revokedAt; bytes32 measurement;
    kind, registeredAt, expiresAt, revokedAt, measurement = signers(s);
    return measurement;
}

/// Measurement ids start at 1, so the id of a measurement never allowed is never allowed.
invariant noAllowedIdZero()
    !allowedId(0);

/// An admitted signer's cached measurement id is the id of its measurement, which is never zero.
invariant signerMeasurementConsistent(address s)
    expiresAtOf(s) != 0 => signerMeasurementId(s) == measurementId(measurementOf(s)) && signerMeasurementId(s) != 0
    {
        preserved {
            requireInvariant noAllowedIdZero();
        }
    }

// ---------------------------------------------------------------- SIG1

/// `verify2of2` accepts only two distinct recovered signers, an active TDX one then an active Nitro one, each of whose
/// measurements is allowed.
rule verify2of2Sound(env e, bytes32 digest, bytes sigs) {
    address tdx = recoverPart(digest, sigs, 0);
    address nitro = recoverPart(digest, sigs, 65);
    requireInvariant signerMeasurementConsistent(tdx);
    requireInvariant signerMeasurementConsistent(nitro);
    bool ok = verify2of2(e, digest, sigs);
    assert ok => sigs.length == 130 && tdx != nitro && tdx != 0 && nitro != 0;
    assert ok => isActive(e, tdx, TDX()) && isActive(e, nitro, NITRO());
    assert ok => allowedMeasurement(measurementOf(tdx)) && allowedMeasurement(measurementOf(nitro));
}

rule verify2of2SoundReachable(env e, bytes32 digest, bytes sigs) {
    satisfy verify2of2(e, digest, sigs);
}

// ---------------------------------------------------------------- SIG2

rule revocationPermanent(env e, method f, calldataarg args, address s) {
    uint40 before = revokedAtOf(s);
    f(e, args);
    assert before != 0 => revokedAtOf(s) == before;
}

rule revocationPermanentReachable(env e, address s) {
    require revokedAtOf(s) == 0;
    revokeSigner(e, s);
    satisfy revokedAtOf(s) != 0;
}

// ---------------------------------------------------------------- SIG3

/// Outside the three registration functions no signer record is created or extended, and an inactive signer becomes
/// active only when governance allows again the measurement it was admitted with.
rule activeOnlyViaRegistration(env e, method f, calldataarg args, address s, uint8 kind)
    filtered { f -> !isRegistration(f) && !f.isView }
{
    bool activeBefore = isActive(e, s, kind);
    uint40 expiresBefore = expiresAtOf(s);
    bytes32 measurementBefore = measurementOf(s);
    f(e, args);
    assert expiresAtOf(s) == expiresBefore && measurementOf(s) == measurementBefore;
    assert !activeBefore && isActive(e, s, kind)
        => f.selector == sig:setAllowedMeasurement(bytes32, bool).selector && expiresBefore != 0;
}

rule activeOnlyViaRegistrationReachable(env e, method f, calldataarg args, address s)
    filtered { f -> f.selector == sig:registerSignerWithQuote(bytes, DstackEvents.RuntimeEvent[], IVerdictVerifier.SignerBinding, uint256).selector }
{
    require !isActive(e, s, TDX()) && !isActive(e, s, NITRO());
    f(e, args);
    satisfy isActive(e, s, TDX()) || isActive(e, s, NITRO());
}

// ---------------------------------------------------------------- SIG4

rule verifyDegradedTdxOnly(env e, bytes32 digest, bytes signature) {
    address signer = recover(digest, signature);
    bool ok = verifyDegraded(e, digest, signature);
    assert ok => signature.length == 65 && isActive(e, signer, TDX()) && !isActive(e, signer, NITRO());
}

rule verifyDegradedTdxOnlyReachable(env e, bytes32 digest, bytes signature) {
    satisfy verifyDegraded(e, digest, signature);
}

// ---------------------------------------------------------------- I8

/// The issuer, the measurement allowlist and revocations change only in a call the AccessManager authorizes for this
/// function's selector, at once or by consuming an operation scheduled past its delay; the one exception is the
/// permissionless revocation of a signer proven to have equivocated.
rule registryChangesNeedAuthority(env e, method f, calldataarg args, bytes32 measurement, address s) filtered { f -> !f.isView } {
    require !authorityApproved;
    bytes32 issuerBefore = issuer();
    bool allowedBefore = allowedMeasurement(measurement);
    uint64 idBefore = measurementId(measurement);
    uint40 revokedBefore = revokedAtOf(s);

    f(e, args);

    bool authorized = authorityApproved && approvedCaller == e.msg.sender;
    assert issuer() != issuerBefore || allowedMeasurement(measurement) != allowedBefore
        || measurementId(measurement) != idBefore => authorized;
    assert revokedAtOf(s) != revokedBefore
        => authorized || f.selector == sig:reportEquivocation(KeelsonTypes.Countersign, KeelsonTypes.Countersign, bytes, bytes).selector;
}

rule registryChangesNeedAuthorityReachable(env e, bytes32 issuer_) {
    require issuer() != issuer_;
    setIssuer(e, issuer_);
    satisfy issuer() == issuer_;
}
