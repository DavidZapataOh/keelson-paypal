// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonBondVault} from "../src/KeelsonBondVault.sol";
import {MandateViolationCourt} from "../src/MandateViolationCourt.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {IVerdictVerifier} from "../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "../src/libraries/PasskeyAssertion.sol";
import {ForkTest} from "./utils/Fork.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The deployed court convicts a purchase that violated its mandate, and the deployed vault slashes it on the
/// R00 verdict both live legs signed (`test/vectors/c2a-live-verdict.json`), on a fork of Arbitrum Sepolia at the block
/// the verdict names. The live legs never countersign a violating cart, so the countersign is signed by two fork-only
/// keys written into the forked `VerdictVerifier` under the measurements the live legs run; the passkey is a fresh
/// P-256 key and the proof a real C2a proof (`test/vectors/c2a-live-category.json`).
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract MandateViolationLiveVerdictForkTest is ForkTest {
    using stdJson for string;

    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 internal constant MEASUREMENT_IDS_SLOT = 4;
    uint256 internal constant SIGNERS_SLOT = 7;

    function test_aConvictedViolationIsSlashedOnTheLiveLegsVerdict() public {
        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c2a-live-verdict.json"));
        vm.createSelectFork(vm.envString("ARBITRUM_SEPOLIA_RPC_URL"), v.readUint(".forkBlock"));
        string memory reg = _json();
        KeelsonBondVault vault = KeelsonBondVault(reg.readAddress(".contracts.KeelsonBondVault"));
        MandateViolationCourt court = MandateViolationCourt(reg.readAddress(".contracts.MandateViolationCourt"));
        IVerdictVerifier verifier = vault.verifier();
        KeelsonTypes.Verdict memory verdict = _verdict(v);

        // Fork-only countersign keys, under the measurements of the live signers.
        (uint256 tdxKey, uint256 nitroKey) = _countersignKeys(verifier, v);
        // The operator's signature: the demo agent moves to a key this test holds.
        (address operator, uint256 operatorKey) = makeAddrAndKey("agent owner");
        address owner = _identity().ownerOf(verdict.agentId);
        vm.prank(owner);
        _identity().transferFrom(owner, operator, verdict.agentId);

        string memory p = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c2a-live-category.json"));
        bytes32[] memory inputs = p.readBytes32Array(".publicInputs");
        uint256 passkey = uint256(keccak256("the user's passkey")) % P256_N;
        (uint256 qx, uint256 qy) = vm.publicKeyP256(passkey);
        bytes32 hSd = keccak256("payload");
        uint40 issuedAt = uint40(uint256(inputs[5]));
        KeelsonTypes.Countersign memory cs = KeelsonTypes.Countersign({
            requestId: verdict.coverageId,
            mandateHash: PasskeyAssertion.mandateChallenge(hSd, inputs[0]),
            mandateCommitment: inputs[0],
            cartHash: keccak256("cart"),
            agentId: verdict.agentId,
            merchantId: inputs[4],
            amount: uint64(uint256(inputs[1])),
            currency: uint16(uint256(inputs[2])),
            category: uint8(uint256(inputs[3])),
            evidenceRoot: keccak256("evidence"),
            evalHash: keccak256("eval"),
            policySetHash: verdict.policySetHash,
            decision: 1,
            failedFieldsMask: 0,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 15 minutes
        });
        KeelsonTypes.Coverage memory c = KeelsonTypes.Coverage({
            coverageId: verdict.coverageId,
            agentId: verdict.agentId,
            merchant: verdict.payee,
            amount: uint96(cs.amount) * 10_000,
            premium: 0,
            expiresAt: issuedAt + 1 days,
            mandateHash: cs.mandateHash,
            amberCommitment: bytes32(0),
            userKeyHash: keccak256(abi.encodePacked(qx, qy))
        });
        bytes32 csDigest = verifier.hashTypedData(KeelsonTypes.hash(cs));
        bytes memory countersigs = bytes.concat(_signDigest(tdxKey, csDigest), _signDigest(nitroKey, csDigest));

        vm.warp(issuedAt);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(operatorKey, _vaultDigest(vault, KeelsonTypes.hash(c)));
        vault.lockCoverage(
            c,
            cs,
            hSd,
            _passkeyAssertion(vault, passkey, cs.mandateHash),
            bytes32(qx),
            bytes32(qy),
            abi.encodePacked(r, s, sv),
            countersigs
        );

        vm.prank(makeAddr("user"));
        court.proveViolation(c, cs, hSd, countersigs, court.CATEGORY_NOT_ALLOWED(), p.readBytes(".proof"));
        (uint8 code,,) = court.violations(c.coverageId);
        assertEq(code, court.CATEGORY_NOT_ALLOWED());

        address recipient = vault.payoutAddress(verdict.payee);
        if (recipient == address(0)) recipient = verdict.payee;
        uint256 before = _pyusd().balanceOf(recipient);
        bytes memory sigs = bytes.concat(v.readBytes(".signatures.tdx"), v.readBytes(".signatures.nitro"));
        assertEq(verifier.hashTypedData(KeelsonTypes.hash(verdict)), v.readBytes32(".digest"), "live digest");
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.Slashed(
            verdict.disputeId,
            verdict.coverageId,
            verdict.agentId,
            verdict.payee,
            verdict.amount,
            verdict.fieldId,
            verdict.evidenceHash,
            v.readBytes32(".digest")
        );
        vault.slash(verdict, uint64(v.readUint(".treeSize")), sigs);
        assertEq(_pyusd().balanceOf(recipient) - before, verdict.amount);
    }

    function _verdict(string memory v) internal pure returns (KeelsonTypes.Verdict memory) {
        return KeelsonTypes.Verdict({
            disputeId: v.readBytes32(".verdict.disputeId"),
            coverageId: v.readBytes32(".verdict.coverageId"),
            agentId: vm.parseUint(v.readString(".verdict.agentId")),
            payee: v.readAddress(".verdict.payee"),
            amount: uint96(vm.parseUint(v.readString(".verdict.amount"))),
            ruleId: uint8(vm.parseUint(v.readString(".verdict.ruleId"))),
            liable: uint8(vm.parseUint(v.readString(".verdict.liable"))),
            fieldId: uint8(vm.parseUint(v.readString(".verdict.fieldId"))),
            evidenceHash: v.readBytes32(".verdict.evidenceHash"),
            inputsHash: v.readBytes32(".verdict.inputsHash"),
            policySetHash: v.readBytes32(".verdict.policySetHash"),
            checkpointRoot: v.readBytes32(".verdict.checkpointRoot"),
            issuedAt: uint40(vm.parseUint(v.readString(".verdict.issuedAt"))),
            deadline: uint40(vm.parseUint(v.readString(".verdict.deadline")))
        });
    }

    /// @dev Two keys written as a TDX and a Nitro signer at the slots `forge inspect VerdictVerifier storageLayout`
    /// reports, under the measurements of the live signers the vector names.
    function _countersignKeys(IVerdictVerifier verifier, string memory v)
        internal
        returns (uint256 tdxKey, uint256 nitroKey)
    {
        address tdx;
        address nitro;
        (tdx, tdxKey) = makeAddrAndKey("fork-only tdx countersign signer");
        (nitro, nitroKey) = makeAddrAndKey("fork-only nitro countersign signer");
        (,,,, bytes32 tdxMeasurement) = verifier.signers(v.readAddress(".signers.tdx"));
        (,,,, bytes32 nitroMeasurement) = verifier.signers(v.readAddress(".signers.nitro"));
        _writeSigner(verifier, tdx, 1, tdxMeasurement);
        _writeSigner(verifier, nitro, 2, nitroMeasurement);
        assertTrue(verifier.isActive(tdx, 1) && verifier.isActive(nitro, 2), "countersign signers");
    }

    function _writeSigner(IVerdictVerifier verifier, address signer, uint8 teeKind, bytes32 measurement) internal {
        uint256 id = uint256(vm.load(address(verifier), keccak256(abi.encode(measurement, MEASUREMENT_IDS_SLOT))));
        assertGt(id, 0, "measurement registered");
        bytes32 slot = keccak256(abi.encode(signer, SIGNERS_SLOT));
        uint256 packed = uint256(teeKind) | vm.getBlockTimestamp() << 8 | uint256(type(uint40).max) << 48 | id << 128;
        vm.store(address(verifier), slot, bytes32(packed));
        vm.store(address(verifier), bytes32(uint256(slot) + 1), measurement);
    }

    function _signDigest(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, sv);
    }

    function _vaultDigest(KeelsonBondVault vault, bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash));
    }

    function _passkeyAssertion(KeelsonBondVault vault, uint256 passkey, bytes32 challenge)
        internal
        view
        returns (PasskeyAssertion.Assertion memory a)
    {
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
}
