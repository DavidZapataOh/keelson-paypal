// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployMandateViolationCourt} from "../script/DeployMandateViolationCourt.s.sol";
import {MandateViolationCourt} from "../src/MandateViolationCourt.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "../src/libraries/PasskeyAssertion.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {SlashBase} from "./utils/SlashBase.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice A purchase that violated its mandate, convicted with a real C2a proof against the countersign its coverage
/// was locked with, then slashed through the vault on a fork of Arbitrum Sepolia with real PYUSD and the real
/// `CheckpointAnchor`. The TEE legs never countersign a violating cart, so these countersigns, like the verdicts, are
/// signed by the fork-only signers; the passkey is a fresh P-256 key.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract MandateViolationForkTest is SlashBase {
    using stdJson for string;

    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    /// @dev R00: a purchase without a valid proof of its mandate is the operator's.
    uint8 internal constant R00 = 0;
    uint8 internal constant NO_FIELD = 0xff;
    uint96 internal constant SLASH = 50e6;
    uint256 internal constant BOND_TOP_UP = 500e6;
    uint256 internal constant EXPIRES_AT = 48;
    uint256 internal constant REVOKED_AT = 88;

    MandateViolationCourt internal court;
    uint256 internal passkey;

    struct Case {
        KeelsonTypes.Coverage coverage;
        KeelsonTypes.Countersign countersign;
        bytes countersigs;
        bytes proof;
        uint8 code;
        bytes32 hSd;
    }

    function setUp() public override {
        super.setUp();
        court = new DeployMandateViolationCourt().run();
        // Enough bond for a purchase over the demo mandate's 100.00 maximum.
        (address funder,) = _funder(0);
        _fundFromHolder(funder, BOND_TOP_UP);
        _deposit(0, BOND_TOP_UP, "violation bond");
        passkey = uint256(keccak256("the user's passkey")) % P256_N;
    }

    // Each violation class convicts and slashes.

    function test_amountOverMaximum_isSlashed() public {
        _convictAndSlash("amount", court.AMOUNT_OVER_MAX());
    }

    function test_currencyMismatch_isSlashed() public {
        _convictAndSlash("currency", court.CURRENCY_MISMATCH());
    }

    function test_categoryNotAllowed_isSlashed() public {
        _convictAndSlash("category", court.CATEGORY_NOT_ALLOWED());
    }

    function test_expiredMandate_isSlashed() public {
        _convictAndSlash("expiry", court.MANDATE_EXPIRED());
    }

    function test_merchantNotAllowed_isSlashed() public {
        _convictAndSlash("merchant", court.MERCHANT_NOT_ALLOWED());
    }

    function test_degradedCoverage_isConvictedOnTheTdxSignature() public {
        Case memory k = _case("category", court.CATEGORY_NOT_ALLOWED());
        k.countersigs = _signCountersign(tdxKey, k.countersign);
        _lockCase(k);
        court.proveViolation(k.coverage, k.countersign, k.countersigs, k.code, k.proof);
        assertEq(_code(k), k.code);
    }

    function test_gas_proveViolation() public {
        Case memory k = _lockedCase("merchant", court.MERCHANT_NOT_ALLOWED());
        court.proveViolation(k.coverage, k.countersign, k.countersigs, k.code, k.proof);
        uint256 gas = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("proveViolation", gas);
        GasBudget.check("c2a_proveViolation", gas);
    }

    // A valid cart cannot be convicted: no proof of its violation exists, and another proof does not fit it.

    function test_compliantCountersign_isNotConvicted() public {
        Case memory k = _case("amount", court.AMOUNT_OVER_MAX());
        k.countersign.amount = 8500;
        k.coverage.amount = 8500 * 10_000;
        k.countersigs = _countersign(k.countersign);
        _lockCase(k);
        _expectRevert(k, MandateViolationCourt.InvalidProof.selector);
    }

    function test_proofOfAnotherCode_isRejected() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        k.code = court.CATEGORY_NOT_ALLOWED();
        _expectRevert(k, MandateViolationCourt.InvalidProof.selector);
    }

    function test_unknownCode_isRejected() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        k.code = 0;
        _expectRevert(k, MandateViolationCourt.UnknownViolation.selector);
        k.code = 6;
        _expectRevert(k, MandateViolationCourt.UnknownViolation.selector);
    }

    function test_secondConviction_isRejected() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        court.proveViolation(k.coverage, k.countersign, k.countersigs, k.code, k.proof);
        _expectRevert(k, MandateViolationCourt.AlreadyProven.selector);
    }

    // Only the countersign the coverage was locked with counts.

    function test_unlockedCoverage_isRejected() public {
        Case memory k = _case("amount", court.AMOUNT_OVER_MAX());
        _expectRevert(k, MandateViolationCourt.NotCovered.selector);
    }

    function test_alteredCoverage_isRejected() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        k.coverage.merchant = makeAddr("someone else");
        _expectRevert(k, MandateViolationCourt.NotCovered.selector);
    }

    function test_denyCountersign_isRejected() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        k.countersign.decision = 2;
        k.countersigs = _countersign(k.countersign);
        _expectRevert(k, MandateViolationCourt.CountersignMismatch.selector);
    }

    function test_countersignOfAnotherPurchase_isRejected() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        KeelsonTypes.Countersign memory locked = k.countersign;

        k.countersign.requestId = keccak256("another request");
        k.countersigs = _countersign(k.countersign);
        _expectRevert(k, MandateViolationCourt.CountersignMismatch.selector);

        k.countersign = locked;
        k.countersign.agentId = agentId + 1;
        k.countersigs = _countersign(k.countersign);
        _expectRevert(k, MandateViolationCourt.CountersignMismatch.selector);

        k.countersign = locked;
        k.countersign.mandateHash = keccak256("another mandate");
        k.countersigs = _countersign(k.countersign);
        _expectRevert(k, MandateViolationCourt.CountersignMismatch.selector);

        k.countersign = locked;
        k.countersign.amount = locked.amount - 1;
        k.countersigs = _countersign(k.countersign);
        _expectRevert(k, MandateViolationCourt.CountersignMismatch.selector);
    }

    function test_alteredCountersign_isRejected() public {
        Case memory k = _lockedCase("merchant", court.MERCHANT_NOT_ALLOWED());
        k.countersign.merchantId = bytes32(uint256(k.countersign.merchantId) + 1);
        _expectRevert(k, MandateViolationCourt.InvalidCountersignature.selector);
    }

    function test_unregisteredOrSwappedSigners_areRejected() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        bytes memory tdx = _signCountersign(tdxKey, k.countersign);
        bytes memory nitro = _signCountersign(nitroKey, k.countersign);
        bytes memory stranger = _signCountersign(uint256(keccak256("not a TEE")), k.countersign);

        k.countersigs = bytes.concat(nitro, tdx);
        _expectRevert(k, MandateViolationCourt.InvalidCountersignature.selector);
        k.countersigs = bytes.concat(tdx, stranger);
        _expectRevert(k, MandateViolationCourt.InvalidCountersignature.selector);
        k.countersigs = nitro;
        _expectRevert(k, MandateViolationCourt.InvalidCountersignature.selector);
        k.countersigs = bytes.concat(tdx, nitro, hex"00");
        _expectRevert(k, MandateViolationCourt.InvalidCountersignature.selector);
    }

    function test_signerNotYetRegisteredAtIssue_isRejected() public {
        Case memory k = _case("amount", court.AMOUNT_OVER_MAX());
        (, uint40 registeredAt,,,) = verdictVerifier.signers(vm.addr(tdxKey));
        k.countersign.issuedAt = registeredAt - 1;
        k.countersign.expiresAt = registeredAt + 15 minutes;
        k.coverage.expiresAt = registeredAt + 1 days;
        k.countersigs = _countersign(k.countersign);
        _lockCase(k);
        _expectRevert(k, MandateViolationCourt.InvalidCountersignature.selector);
    }

    function test_revokedSigner_isRejected() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        _setRecord(vm.addr(nitroKey), REVOKED_AT, uint40(block.timestamp));
        _expectRevert(k, MandateViolationCourt.InvalidCountersignature.selector);
    }

    function test_signerLapsedBeforeIssue_isRejected() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        _setRecord(vm.addr(tdxKey), EXPIRES_AT, k.countersign.issuedAt);
        _expectRevert(k, MandateViolationCourt.InvalidCountersignature.selector);
    }

    /// @dev A dispute can come months after the countersign, when its signers' registrations have lapsed.
    function test_conviction_survivesTheSignersRegistrationLapsing() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        _setRecord(vm.addr(tdxKey), EXPIRES_AT, k.countersign.issuedAt + 1 hours);
        _setRecord(vm.addr(nitroKey), EXPIRES_AT, k.countersign.issuedAt + 1 hours);
        vm.warp(block.timestamp + 180 days);
        assertFalse(
            verdictVerifier.verify2of2(verdictVerifier.hashTypedData(KeelsonTypes.hash(k.countersign)), k.countersigs)
        );
        court.proveViolation(k.coverage, k.countersign, k.countersigs, k.code, k.proof);
        assertEq(_code(k), k.code);
    }

    // Helpers

    function _convictAndSlash(string memory name, uint8 code) internal {
        Case memory k = _lockedCase(name, code);
        bytes32 digest = verdictVerifier.hashTypedData(KeelsonTypes.hash(k.countersign));
        vm.expectEmit(address(court));
        emit MandateViolationCourt.MandateViolationProven(k.coverage.coverageId, agentId, code, digest);
        vm.prank(makeAddr("user"));
        court.proveViolation(k.coverage, k.countersign, k.countersigs, code, k.proof);
        (uint8 recorded,, bytes32 against) = court.violations(k.coverage.coverageId);
        assertEq(recorded, code);
        assertEq(against, digest);

        KeelsonTypes.Verdict memory v = KeelsonTypes.Verdict({
            disputeId: keccak256(abi.encode("PP-D-violation", k.coverage.coverageId)),
            coverageId: k.coverage.coverageId,
            agentId: agentId,
            payee: merchant,
            amount: SLASH,
            ruleId: R00,
            liable: OPERATOR,
            fieldId: NO_FIELD,
            evidenceHash: digest,
            inputsHash: keccak256("facts: proof_valid = false"),
            policySetHash: k.countersign.policySetHash,
            checkpointRoot: checkpointRoot,
            issuedAt: uint40(block.timestamp),
            deadline: uint40(block.timestamp + 1 hours)
        });
        uint256 before = pyusd.balanceOf(merchant);
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.Slashed(
            v.disputeId, v.coverageId, agentId, merchant, SLASH, NO_FIELD, digest, _digest(v)
        );
        _slash(v);
        assertEq(pyusd.balanceOf(merchant) - before, SLASH);
        _assertBacked();
    }

    /// @dev Overwrites one 40-bit field of a signer's `VerdictVerifier.Record`: `teeKind` (8) ‖ `registeredAt` ‖
    /// `expiresAt` ‖ `revokedAt` ‖ `measurementId` (64), low bits first.
    function _setRecord(address signer, uint256 shift, uint40 value) internal {
        bytes32 slot = keccak256(abi.encode(signer, SIGNERS_SLOT));
        uint256 packed = uint256(vm.load(address(verdictVerifier), slot));
        packed = packed & ~(uint256(type(uint40).max) << shift) | uint256(value) << shift;
        vm.store(address(verdictVerifier), slot, bytes32(packed));
    }

    function _code(Case memory k) internal view returns (uint8 code) {
        (code,,) = court.violations(k.coverage.coverageId);
    }

    function _expectRevert(Case memory k, bytes4 selector) internal {
        vm.expectRevert(selector);
        court.proveViolation(k.coverage, k.countersign, k.countersigs, k.code, k.proof);
    }

    function _lockedCase(string memory name, uint8 code) internal returns (Case memory k) {
        k = _case(name, code);
        _lockCase(k);
    }

    /// @dev The class's proof and the countersign whose fields are its public inputs, issued at the proof's cart time.
    function _case(string memory name, uint8 code) internal view returns (Case memory k) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c2a-", name, ".json"));
        bytes32[] memory inputs = json.readBytes32Array(".publicInputs");
        assertEq(uint256(inputs[6]), code, "vector code");
        k.proof = json.readBytes(".proof");
        k.code = code;
        k.hSd = keccak256(abi.encode("payload", name));
        uint40 issuedAt = uint40(uint256(inputs[5]));
        k.countersign = KeelsonTypes.Countersign({
            requestId: keccak256(abi.encode("c2a", name)),
            mandateHash: PasskeyAssertion.mandateChallenge(k.hSd, inputs[0]),
            mandateCommitment: inputs[0],
            cartHash: keccak256(abi.encode("cart", name)),
            agentId: agentId,
            merchantId: inputs[4],
            amount: uint64(uint256(inputs[1])),
            currency: uint16(uint256(inputs[2])),
            category: uint8(uint256(inputs[3])),
            evidenceRoot: keccak256("evidence"),
            evalHash: keccak256("eval"),
            policySetHash: keccak256("policies"),
            decision: 1,
            failedFieldsMask: 0,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 15 minutes
        });
        (uint256 qx, uint256 qy) = vm.publicKeyP256(passkey);
        k.coverage = KeelsonTypes.Coverage({
            coverageId: k.countersign.requestId,
            agentId: agentId,
            merchant: merchant,
            amount: uint96(k.countersign.amount) * 10_000,
            premium: 0,
            expiresAt: issuedAt + 1 days,
            mandateHash: k.countersign.mandateHash,
            amberCommitment: bytes32(0),
            userKeyHash: keccak256(abi.encodePacked(qx, qy))
        });
        k.countersigs = _countersign(k.countersign);
    }

    /// @dev Locked at the countersign's issue time, as the relayer submits it.
    function _lockCase(Case memory k) internal {
        vm.warp(k.countersign.issuedAt);
        (uint256 qx, uint256 qy) = vm.publicKeyP256(passkey);
        vault.lockCoverage(
            k.coverage,
            k.countersign,
            k.hSd,
            _assert(k.countersign.mandateHash),
            bytes32(qx),
            bytes32(qy),
            _operatorSig(k.coverage),
            k.countersigs
        );
    }

    function _assert(bytes32 challenge) internal view returns (PasskeyAssertion.Assertion memory a) {
        a.authenticatorData = abi.encodePacked(vault.rpIdHash(), bytes1(0x05), bytes4(0));
        a.clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"https://keelson.finance"}'
        );
        a.typeIndex = 1;
        a.challengeIndex = 23;
        (a.r, a.s) =
            vm.signP256(passkey, sha256(abi.encodePacked(a.authenticatorData, sha256(bytes(a.clientDataJSON)))));
        if (uint256(a.s) > P256_N / 2) a.s = bytes32(P256_N - uint256(a.s));
    }

    function _countersign(KeelsonTypes.Countersign memory cs) internal view returns (bytes memory) {
        return bytes.concat(_signCountersign(tdxKey, cs), _signCountersign(nitroKey, cs));
    }

    function _signCountersign(uint256 pk, KeelsonTypes.Countersign memory cs) internal view returns (bytes memory) {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(pk, verdictVerifier.hashTypedData(KeelsonTypes.hash(cs)));
        return abi.encodePacked(r, s, sv);
    }
}
