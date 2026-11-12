// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployEngineProofCourt} from "../script/DeployEngineProofCourt.s.sol";
import {EngineProofCourt} from "../src/EngineProofCourt.sol";
import {EngineProofVerifier} from "../src/EngineProofVerifier.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {IKeelsonValidationRegistry} from "../src/interfaces/IKeelsonValidationRegistry.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "../src/libraries/PasskeyAssertion.sol";
import {Erc8004Base} from "./utils/Erc8004Base.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {ISP1Verifier} from "@sp1-contracts/ISP1Verifier.sol";
import {SP1Verifier} from "@sp1-contracts/v6.1.0/SP1VerifierGroth16.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice A slash disputed with the SP1 proof of the engine's evaluation. The coverage is locked with the engine's
/// countersign vector, and the proof is Succinct's SP1 v6.1.0 Groth16 proof of that countersign, made by the engine
/// program whose key is deployed and verified by Succinct's v6.1.0 verifier. Only the TEE signers are the fork's own
/// keys: a slash they sign for a field the proven evaluation passed is what a compromised pair of legs would queue.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract EngineProofCourtForkTest is Erc8004Base {
    using stdJson for string;

    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    /// @dev `FIELD_BITS.merchant`: a field only the evaluation decides.
    uint8 internal constant MERCHANT_FIELD = 5;
    uint8 internal constant R31 = 31;

    EngineProofVerifier internal engineProofs;
    EngineProofCourt internal court;
    KeelsonTypes.Countersign internal cs;
    bytes internal publicValues;
    bytes internal proof;
    bytes32 internal hSd;

    function setUp() public override {
        super.setUp();
        string memory proofJson = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/engine-proof.json"));
        string memory program = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/engine-program.json"));
        assertEq(proofJson.readBytes32(".vkey"), program.readBytes32(".vkey"), "the proof is of the deployed program");
        publicValues = proofJson.readBytes(".public_values");
        proof = proofJson.readBytes(".proof");
        engineProofs = new EngineProofVerifier(ISP1Verifier(address(new SP1Verifier())), program.readBytes32(".vkey"));
        court = new EngineProofCourt(
            vault, vault.verifier(), IKeelsonValidationRegistry(address(validation)), engineProofs
        );
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            new DeployEngineProofCourt().grants(address(court));
        _viaTimelockBatch(targets, values, payloads);
        IKeelsonBondVault.Params memory p = vault.params();
        // Every slash waits for its veto window.
        p.instantSlashCap = 0;
        _viaTimelock(address(vault), abi.encodeCall(vault.setParams, (p)));
        _readCountersign();
        assertEq(proofJson.readBytes32(".countersign_digest"), _csDigest(), "the proof is of the vector's countersign");
    }

    function _viaTimelockBatch(address[] memory targets, uint256[] memory values, bytes[] memory payloads) internal {
        TimelockController timelock = _timelock();
        uint256 delay = timelock.getMinDelay();
        vm.prank(_json().readAddress(".governance.proposer"));
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), delay);
        vm.warp(vm.getBlockTimestamp() + delay);
        timelock.executeBatch(targets, values, payloads, bytes32(0), bytes32(0));
    }

    function _readCountersign() internal {
        string memory v =
            vm.readFile(string.concat(vm.projectRoot(), "/../engine/tee/tests/vectors/countersign-allow.json"));
        hSd = v.readBytes32(".h_sd");
        cs = KeelsonTypes.Countersign({
            requestId: v.readBytes32(".countersign.requestId"),
            mandateHash: v.readBytes32(".countersign.mandateHash"),
            mandateCommitment: v.readBytes32(".countersign.mandateCommitment"),
            cartHash: v.readBytes32(".countersign.cartHash"),
            agentId: vm.parseUint(v.readString(".countersign.agentId")),
            merchantId: v.readBytes32(".countersign.merchantId"),
            amount: uint64(vm.parseUint(v.readString(".countersign.amount"))),
            currency: uint16(vm.parseUint(v.readString(".countersign.currency"))),
            category: uint8(vm.parseUint(v.readString(".countersign.category"))),
            evidenceRoot: v.readBytes32(".countersign.evidenceRoot"),
            evalHash: v.readBytes32(".countersign.evalHash"),
            policySetHash: v.readBytes32(".countersign.policySetHash"),
            decision: uint8(vm.parseUint(v.readString(".countersign.decision"))),
            failedFieldsMask: uint32(vm.parseUint(v.readString(".countersign.failedFieldsMask"))),
            issuedAt: uint40(vm.parseUint(v.readString(".countersign.issuedAt"))),
            expiresAt: uint40(vm.parseUint(v.readString(".countersign.expiresAt")))
        });
        assertEq(v.readBytes32(".digest"), _csDigest(), "vector digest");
        assertEq(cs.agentId, agentId, "the vector is the demo agent's");
    }

    function _csDigest() internal view returns (bytes32) {
        return vault.verifier().hashTypedData(KeelsonTypes.hash(cs));
    }

    /// @dev A user-verified WebAuthn assertion over the countersign's mandate challenge by a passkey this test holds.
    function _assertion(uint256 pk) internal view returns (PasskeyAssertion.Assertion memory a) {
        a.authenticatorData = abi.encodePacked(vault.rpIdHash(), bytes1(0x05), uint32(1));
        a.clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(cs.mandateHash)),
            '","origin":"https://keelson.finance"}'
        );
        a.typeIndex = 1;
        a.challengeIndex = 23;
        (a.r, a.s) = vm.signP256(pk, sha256(abi.encodePacked(a.authenticatorData, sha256(bytes(a.clientDataJSON)))));
        if (uint256(a.s) > P256_N / 2) a.s = bytes32(P256_N - uint256(a.s));
    }

    /// @dev Locks the vector's coverage at its countersign's issue time, as the relayer submits it, and records its
    /// countersign in the validation registry when `recorded`.
    function _lockVector(bool recorded) internal {
        vm.warp(cs.issuedAt);
        // The fork's signers must be registered when the legs countersigned.
        _installVerdictSigners(vault.verifier());
        uint256 pk = uint256(keccak256("engine proof court passkey")) % P256_N;
        (uint256 qx, uint256 qy) = vm.publicKeyP256(pk);
        KeelsonTypes.Coverage memory c = KeelsonTypes.Coverage({
            coverageId: cs.requestId,
            agentId: cs.agentId,
            merchant: merchant,
            amount: uint96(uint256(cs.amount) * 10_000),
            premium: 0,
            expiresAt: uint40(cs.issuedAt + vault.params().disputeWindow + 1 hours),
            mandateHash: cs.mandateHash,
            amberCommitment: 0,
            userKeyHash: keccak256(abi.encodePacked(qx, qy))
        });
        bytes memory sigs = _sign2of2(cs);
        vault.lockCoverage(
            c, cs, hSd, _assertion(pk), bytes32(qx), bytes32(qy), _signVault(operatorKey, KeelsonTypes.hash(c)), sigs
        );
        if (recorded) assertEq(validation.recordCountersign(cs, sigs, ""), _csDigest());
    }

    function _fieldVerdict(uint8 ruleId, uint8 fieldId) internal view returns (KeelsonTypes.Verdict memory) {
        return KeelsonTypes.Verdict({
            disputeId: keccak256(abi.encode("PP-D-engine", cs.requestId, ruleId, fieldId)),
            coverageId: cs.requestId,
            agentId: cs.agentId,
            payee: merchant,
            amount: uint96(uint256(cs.amount) * 10_000),
            ruleId: ruleId,
            liable: OPERATOR,
            fieldId: fieldId,
            evidenceHash: keccak256("evidence"),
            inputsHash: keccak256("inputs"),
            policySetHash: cs.policySetHash,
            checkpointRoot: checkpointRoot,
            issuedAt: uint40(vm.getBlockTimestamp()),
            deadline: uint40(vm.getBlockTimestamp() + 1 hours)
        });
    }

    /// @dev Locks the coverage and queues a slash under `ruleId` for `fieldId`.
    function _queued(uint8 ruleId, uint8 fieldId) internal returns (KeelsonTypes.Verdict memory v) {
        _lockVector(true);
        v = _fieldVerdict(ruleId, fieldId);
        _slash(v);
        assertEq(uint8(vault.queuedSlashes(v.disputeId).status), uint8(IKeelsonBondVault.SlashStatus.Queued));
    }

    function test_contest_vetoesASlashTheProvenEvaluationContradicts() public {
        KeelsonTypes.Verdict memory v = _queued(R61, MERCHANT_FIELD);
        (bytes32 evalHash, bytes32 digest) = engineProofs.record(publicValues, proof);
        assertEq(evalHash, cs.evalHash);
        assertEq(digest, validation.requestOf(cs.requestId));

        vm.expectEmit(address(court));
        emit EngineProofCourt.SlashContested(v.disputeId, digest, MERCHANT_FIELD);
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.SlashVetoed(v.disputeId, "engine proof");
        vm.prank(makeAddr("anyone"));
        court.contest(v);
        GasBudget.check("engine_contest", vm.lastCallGas().gasTotalUsed);

        assertEq(uint8(vault.queuedSlashes(v.disputeId).status), uint8(IKeelsonBondVault.SlashStatus.Vetoed));
        assertEq(vault.slashed(cs.requestId), 0);
        vm.warp(vault.queuedSlashes(v.disputeId).readyAt);
        vm.expectRevert(IKeelsonBondVault.NotQueued.selector);
        vault.executeSlash(v.disputeId);
        assertEq(pyusd.balanceOf(merchant), 0);
    }

    function test_contest_revertsWithoutAProof() public {
        KeelsonTypes.Verdict memory v = _queued(R61, MERCHANT_FIELD);
        vm.expectRevert(EngineProofCourt.NotProven.selector);
        court.contest(v);
    }

    function test_contest_revertsWithoutARecordedCountersign() public {
        _lockVector(false);
        KeelsonTypes.Verdict memory v = _fieldVerdict(R61, MERCHANT_FIELD);
        _slash(v);
        engineProofs.record(publicValues, proof);
        vm.expectRevert(EngineProofCourt.NoCountersign.selector);
        court.contest(v);
    }

    /// @dev Channel3 observes the variant independently: its failure is not the evaluation's.
    function test_contest_revertsForAFieldAnObservationFails() public {
        KeelsonTypes.Verdict memory v = _queued(R61, VARIANT_FIELD);
        engineProofs.record(publicValues, proof);
        vm.expectRevert(EngineProofCourt.NotAnEvaluationFault.selector);
        court.contest(v);
    }

    /// @dev A duplicate capture rests on PayPal's captures, which the evaluation never saw.
    function test_contest_revertsForARuleTheProofDoesNotCover() public {
        KeelsonTypes.Verdict memory v = _queued(R31, MERCHANT_FIELD);
        engineProofs.record(publicValues, proof);
        vm.expectRevert(EngineProofCourt.NotAnEvaluationFault.selector);
        court.contest(v);
    }

    function test_contest_revertsAfterTheVetoWindow() public {
        KeelsonTypes.Verdict memory v = _queued(R61, MERCHANT_FIELD);
        engineProofs.record(publicValues, proof);
        vm.warp(vault.queuedSlashes(v.disputeId).readyAt);
        vm.expectRevert(IKeelsonBondVault.VetoClosed.selector);
        court.contest(v);
    }

    function test_contest_revertsForAnotherVerdict() public {
        KeelsonTypes.Verdict memory v = _queued(R61, MERCHANT_FIELD);
        engineProofs.record(publicValues, proof);
        v.amount -= 1;
        vm.expectRevert(EngineProofCourt.VerdictMismatch.selector);
        court.contest(v);
    }

    function test_contest_revertsWhenNothingIsQueued() public {
        _lockVector(true);
        KeelsonTypes.Verdict memory v = _fieldVerdict(R61, MERCHANT_FIELD);
        vm.expectRevert(EngineProofCourt.NotContestable.selector);
        court.contest(v);
    }

    /// @dev `VETO_ROLE` vetoes and nothing else: the Guardian keeps its veto, the court cannot pause.
    function test_vetoRole_isTheGuardiansAndTheCourtsOnly() public {
        KeelsonTypes.Verdict memory v = _queued(R61, MERCHANT_FIELD);
        vm.prank(address(court));
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, address(court)));
        vault.pause();
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, stranger));
        vault.vetoSlash(v.disputeId, "not mine to veto");
        vm.prank(_json().readAddress(".contracts.GuardianSafe"));
        vault.vetoSlash(v.disputeId, "compromised leg");
        assertEq(uint8(vault.queuedSlashes(v.disputeId).status), uint8(IKeelsonBondVault.SlashStatus.Vetoed));
    }
}
