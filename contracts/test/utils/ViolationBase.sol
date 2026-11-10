// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployMandateViolationCourt} from "../../script/DeployMandateViolationCourt.s.sol";
import {MandateViolationCourt} from "../../src/MandateViolationCourt.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "../../src/libraries/PasskeyAssertion.sol";
import {SlashBase} from "./SlashBase.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Purchases that violated their mandate, locked in a vault deployed on a fork of Arbitrum Sepolia with real
/// PYUSD, and the `MandateViolationCourt` that convicts them with the real C2a proofs of `test/vectors/c2a-*.json`. The
/// TEE legs never countersign a violating cart, so the countersigns are signed by the fork-only signers; the passkey is
/// a fresh P-256 key.
abstract contract ViolationBase is SlashBase {
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

    function setUp() public virtual override {
        super.setUp();
        court = new DeployMandateViolationCourt().run();
        // Enough bond for a purchase over the demo mandate's 100.00 maximum.
        (address funder,) = _funder(0);
        _fundFromHolder(funder, BOND_TOP_UP);
        _deposit(0, BOND_TOP_UP, "violation bond");
        passkey = uint256(keccak256("the user's passkey")) % P256_N;
    }

    function _code(Case memory k) internal view returns (uint8 code) {
        (code,,) = court.violations(k.coverage.coverageId);
    }

    function _expectRevert(Case memory k, bytes4 selector) internal {
        vm.expectRevert(selector);
        court.proveViolation(k.coverage, k.countersign, k.hSd, k.countersigs, k.code, k.proof);
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
