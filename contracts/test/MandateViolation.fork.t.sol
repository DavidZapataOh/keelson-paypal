// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {MandateViolationCourt} from "../src/MandateViolationCourt.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {ViolationBase} from "./utils/ViolationBase.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice A purchase that violated its mandate, convicted with a real C2a proof against the countersign its coverage
/// was locked with, then slashed through the vault on a fork of Arbitrum Sepolia with real PYUSD and the real
/// `CheckpointAnchor`. The TEE legs never countersign a violating cart, so these countersigns, like the verdicts, are
/// signed by the fork-only signers; the passkey is a fresh P-256 key.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract MandateViolationForkTest is ViolationBase {
    using stdJson for string;

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
        court.proveViolation(k.coverage, k.countersign, k.hSd, k.countersigs, k.code, k.proof);
        assertEq(_code(k), k.code);
    }

    function test_gas_proveViolation() public {
        Case memory k = _lockedCase("merchant", court.MERCHANT_NOT_ALLOWED());
        court.proveViolation(k.coverage, k.countersign, k.hSd, k.countersigs, k.code, k.proof);
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
        court.proveViolation(k.coverage, k.countersign, k.hSd, k.countersigs, k.code, k.proof);
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

    function test_tdxSignatureAlone_isRejectedForA2of2Coverage() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        k.countersigs = _signCountersign(tdxKey, k.countersign);
        _expectRevert(k, MandateViolationCourt.InvalidCountersignature.selector);
    }

    /// @dev A countersign that copies the coverage's public fields but commits to another mandate: its `C_m` does not
    /// give the `mandateHash` the user signed.
    function test_countersignOfAnotherMandate_isRejected() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        k.countersign.mandateCommitment = keccak256("a mandate the user never signed");
        k.countersigs = _countersign(k.countersign);
        _expectRevert(k, MandateViolationCourt.CountersignMismatch.selector);
        k.hSd = keccak256("another payload");
        _expectRevert(k, MandateViolationCourt.CountersignMismatch.selector);
    }

    function test_disallowedMeasurement_isRejected() public {
        Case memory k = _lockedCase("amount", court.AMOUNT_OVER_MAX());
        (,,,, bytes32 measurement) = verdictVerifier.signers(vm.addr(nitroKey));
        vm.prank(_json().readAddress(".contracts.GuardianSafe"));
        verdictVerifier.disallowMeasurement(measurement);
        _expectRevert(k, MandateViolationCourt.InvalidCountersignature.selector);
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
        court.proveViolation(k.coverage, k.countersign, k.hSd, k.countersigs, k.code, k.proof);
        assertEq(_code(k), k.code);
    }

    // Helpers

    function _convictAndSlash(string memory name, uint8 code) internal {
        Case memory k = _lockedCase(name, code);
        bytes32 digest = verdictVerifier.hashTypedData(KeelsonTypes.hash(k.countersign));
        vm.expectEmit(address(court));
        emit MandateViolationCourt.MandateViolationProven(k.coverage.coverageId, agentId, code, digest);
        vm.prank(makeAddr("user"));
        court.proveViolation(k.coverage, k.countersign, k.hSd, k.countersigs, code, k.proof);
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
}
