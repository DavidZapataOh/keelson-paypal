// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../script/CoverageVector.sol";
import {IERC8004Validation} from "../src/interfaces/IERC8004Validation.sol";
import {IKeelsonValidationRegistry} from "../src/interfaces/IKeelsonValidationRegistry.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {Erc8004Base} from "./utils/Erc8004Base.sol";
import {GasBudget} from "./utils/GasBudget.sol";

/// @notice One ERC-8004 validation per Alibi, recorded from the live legs' countersignatures over real coverages, and
/// moved to the coverage's outcome.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract ValidationRegistryForkTest is Erc8004Base {
    uint96 internal constant AMOUNT = 50e6;

    function _status(bytes32 requestHash)
        internal
        view
        returns (address validator, uint256 agent, uint8 response, bytes32 responseHash, string memory tag)
    {
        (validator, agent, response, responseHash, tag,) = validation.getValidationStatus(requestHash);
    }

    function _assertStatus(bytes32 requestHash, uint8 response, string memory tag, bytes32 responseHash) internal view {
        (address validator, uint256 agent, uint8 r, bytes32 h, string memory t) = _status(requestHash);
        assertEq(validator, address(vault.verifier()));
        assertEq(agent, agentId);
        assertEq(r, response);
        assertEq(t, tag);
        assertEq(h, responseHash);
    }

    function _record(Vector memory v) internal returns (bytes32) {
        return validation.recordCountersign(v.countersign, v.countersigs, "");
    }

    function _deny() internal view returns (KeelsonTypes.Countersign memory c) {
        c = _vector(WEBAUTHN).countersign;
        c.requestId = keccak256("denied purchase");
        c.decision = DENY;
        c.failedFieldsMask = 1 << 9;
    }

    function test_allow_beforeCoverageIsNotCovered() public {
        Vector memory v = _vector(WEBAUTHN);
        vm.warp(v.countersign.issuedAt);
        vm.expectRevert(IKeelsonValidationRegistry.NotCovered.selector);
        _record(v);
    }

    function test_allow_recordsTheCountersign() public {
        Vector memory v = _locked(WEBAUTHN);
        vm.expectEmit(address(validation));
        emit IERC8004Validation.ValidationRequest(
            address(vault.verifier()),
            agentId,
            string.concat("https://api.keelson.finance/v1/validations/", vm.toString(v.digest)),
            v.digest
        );
        vm.expectEmit(address(validation));
        emit IERC8004Validation.ValidationResponse(
            address(vault.verifier()), agentId, v.digest, 100, "", v.countersign.evalHash, "2of2"
        );
        assertEq(_record(v), v.digest);
        emit log_named_uint("recordCountersign 2of2", vm.lastCallGas().gasTotalUsed);
        GasBudget.check("recordCountersign_2of2_tx", vm.lastCallGas().gasTotalUsed);
        _assertStatus(v.digest, 100, "2of2", v.countersign.evalHash);
        assertEq(validation.requestOf(v.coverage.coverageId), v.digest);
        assertEq(validation.getAgentValidations(agentId)[0], v.digest);
        assertEq(validation.getValidatorRequests(address(vault.verifier()))[0], v.digest);
        assertEq(validation.getIdentityRegistry(), address(_identity()));
        assertEq(validation.getVersion(), "2.0.0");

        vm.expectRevert(IKeelsonValidationRegistry.ValidationExists.selector);
        _record(v);
    }

    function test_degraded_recordsTheTdxSignatureAlone() public {
        Vector memory v = _locked(DEGRADED);
        _record(v);
        emit log_named_uint("recordCountersign degraded", vm.lastCallGas().gasTotalUsed);
        GasBudget.check("recordCountersign_degraded_tx", vm.lastCallGas().gasTotalUsed);
        _assertStatus(v.digest, 100, "degraded", v.countersign.evalHash);
    }

    /// @dev The TDX half of a 2-of-2 countersign must not pass the purchase off as degraded.
    function test_allow_signaturesMustMatchTheCoverage() public {
        Vector memory v = _locked(WEBAUTHN);
        vm.expectRevert(IKeelsonValidationRegistry.InvalidCountersign.selector);
        validation.recordCountersign(v.countersign, v.tdx, "");
    }

    function test_allow_coverageOfAnotherAgentIsNotCovered() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Countersign memory c = v.countersign;
        c.agentId = agentId + 1;
        bytes memory sigs = _sign2of2(c);
        vm.expectRevert(IKeelsonValidationRegistry.NotCovered.selector);
        validation.recordCountersign(c, sigs, "");
    }

    function test_invalidSignatures() public {
        Vector memory v = _locked(WEBAUTHN);
        bytes memory tampered = bytes.concat(v.countersigs);
        tampered[70] = bytes1(uint8(tampered[70]) ^ 1);
        vm.expectRevert(IKeelsonValidationRegistry.InvalidCountersign.selector);
        validation.recordCountersign(v.countersign, tampered, "");

        tampered = bytes.concat(v.countersigs);
        tampered[3] = bytes1(uint8(tampered[3]) ^ 1);
        vm.expectRevert(IKeelsonValidationRegistry.InvalidCountersign.selector);
        validation.recordCountersign(v.countersign, tampered, "");

        vm.expectRevert(IKeelsonValidationRegistry.InvalidCountersign.selector);
        validation.recordCountersign(v.countersign, v.nitro, "");

        vm.expectRevert(IKeelsonValidationRegistry.InvalidCountersign.selector);
        validation.recordCountersign(v.countersign, bytes.concat(v.countersigs, hex"00"), "");
    }

    /// @dev The live TDX signer's registration lasts 72 h.
    function test_expiredSigner() public {
        Vector memory v = _locked(DEGRADED);
        vm.warp(v.countersign.issuedAt + 73 hours);
        vm.expectRevert(IKeelsonValidationRegistry.InvalidCountersign.selector);
        _record(v);
    }

    function test_deny_recordsZeroAndUpgradesFromDegraded() public {
        KeelsonTypes.Countersign memory c = _deny();
        bytes memory sigs = _sign2of2(c);
        bytes memory tdx = _signCountersign(tdxKey, c);
        bytes32 requestHash = validation.recordCountersign(c, tdx, _operatorRequest(c));
        _assertStatus(requestHash, 0, "degraded", c.evalHash);
        assertEq(validation.requestOf(c.requestId), bytes32(0));

        validation.recordCountersign(c, sigs, "");
        _assertStatus(requestHash, 0, "2of2", c.evalHash);

        vm.expectRevert(IKeelsonValidationRegistry.ValidationExists.selector);
        validation.recordCountersign(c, sigs, "");
        vm.expectRevert(IKeelsonValidationRegistry.ValidationExists.selector);
        validation.recordCountersign(c, tdx, "");
    }

    /// @dev Anyone holding a real DENY countersign must not pin a 0 on an agent whose operator did not ask.
    function test_deny_needsTheOperator() public {
        KeelsonTypes.Countersign memory c = _deny();
        bytes memory sigs = _sign2of2(c);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                validation.domainSeparator(),
                keccak256(
                    abi.encode(
                        validation.VALIDATION_REQUEST_TYPEHASH(), verdictVerifier.hashTypedData(KeelsonTypes.hash(c))
                    )
                )
            )
        );
        (, uint256 strangerKey) = makeAddrAndKey("erc8004 stranger");
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(strangerKey, digest);
        vm.expectRevert(IKeelsonValidationRegistry.NotAgentAuthority.selector);
        validation.recordCountersign(c, sigs, abi.encodePacked(r, s, sv));
        vm.expectRevert(IKeelsonValidationRegistry.NotAgentAuthority.selector);
        validation.recordCountersign(c, sigs, "");
    }

    /// @dev Another countersign under the same request id, for another amount, is not the covered one.
    function test_allow_amountMustMatchTheCoverage() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Countersign memory c = v.countersign;
        c.amount -= 1;
        bytes memory sigs = _sign2of2(c);
        vm.expectRevert(IKeelsonValidationRegistry.NotCovered.selector);
        validation.recordCountersign(c, sigs, "");
    }

    function test_unknownDecision() public {
        KeelsonTypes.Countersign memory c = _deny();
        c.decision = 3;
        bytes memory sigs = _sign2of2(c);
        vm.expectRevert(IKeelsonValidationRegistry.InvalidCountersign.selector);
        validation.recordCountersign(c, sigs, "");
    }

    function test_outcome_settled() public {
        Vector memory v = _locked(WEBAUTHN);
        bytes32 id = v.coverage.coverageId;
        vm.expectRevert(IKeelsonValidationRegistry.UnknownValidation.selector);
        validation.recordOutcome(id);
        _record(v);
        vm.expectRevert(IKeelsonValidationRegistry.OutcomeNotFinal.selector);
        validation.recordOutcome(id);

        _release(v);
        vm.expectEmit(address(validation));
        emit IERC8004Validation.ValidationResponse(
            address(vault.verifier()), agentId, v.digest, 100, "", v.countersign.evalHash, "settled"
        );
        validation.recordOutcome(id);
        emit log_named_uint("recordOutcome", vm.lastCallGas().gasTotalUsed);
        GasBudget.check("recordOutcome_tx", vm.lastCallGas().gasTotalUsed);
        _assertStatus(v.digest, 100, "settled", v.countersign.evalHash);
        vm.expectRevert(IKeelsonValidationRegistry.OutcomeRecorded.selector);
        validation.recordOutcome(id);
    }

    function test_outcome_slashed() public {
        Vector memory v = _locked(WEBAUTHN);
        _record(v);
        _slash(_amber(v, AMOUNT));
        validation.recordOutcome(v.coverage.coverageId);
        _assertStatus(v.digest, 0, "slashed", v.countersign.evalHash);
    }

    function test_recordAfterRelease_storesTheOutcome() public {
        Vector memory v = _locked(WEBAUTHN);
        _release(v);
        _record(v);
        _assertStatus(v.digest, 100, "settled", v.countersign.evalHash);
        assertTrue(validation.outcomeRecorded(v.coverage.coverageId));
        vm.expectRevert(IKeelsonValidationRegistry.OutcomeRecorded.selector);
        validation.recordOutcome(v.coverage.coverageId);
    }

    function test_summary() public {
        Vector memory v = _locked(WEBAUTHN);
        _record(v);
        KeelsonTypes.Countersign memory c = _deny();
        validation.recordCountersign(c, _sign2of2(c), _operatorRequest(c));

        (uint64 count, uint8 avg) = validation.getSummary(agentId, _validators(), "");
        assertEq(count, 2);
        assertEq(avg, 50);
        (count, avg) = validation.getSummary(agentId, new address[](0), "2of2");
        assertEq(count, 2);
        (count, avg) = validation.getSummary(agentId, _validators(), "degraded");
        assertEq(count, 0);
        assertEq(avg, 0);
        address[] memory others = new address[](1);
        others[0] = address(this);
        (count,) = validation.getSummary(agentId, others, "");
        assertEq(count, 0);

        vm.expectRevert(IKeelsonValidationRegistry.UnknownValidation.selector);
        validation.getValidationStatus(keccak256("unknown"));
    }
}
