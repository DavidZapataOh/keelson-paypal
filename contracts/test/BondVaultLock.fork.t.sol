// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../script/CoverageVector.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {LockBase} from "./utils/VaultBase.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice `lockCoverage` with the coverages captured live, on a fork of Arbitrum Sepolia: real passkey assertions,
/// the live legs' countersignatures checked by the deployed `VerdictVerifier`, real PYUSD.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract BondVaultLockForkTest is LockBase {
    using stdJson for string;

    uint256 internal constant P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
    uint256 internal constant GAS_BUDGET = 180_000;

    uint256 internal deposited;

    function setUp() public override {
        super.setUp();
        deposited = _depositAll();
    }

    function _lockAndCheck(string memory name) internal {
        Vector memory v = _vector(name);
        vm.warp(v.countersign.issuedAt);
        address reserve = vault.reserve();
        uint256 reserveBefore = pyusd.balanceOf(reserve);
        bytes memory sig = _operatorSig(v.coverage);
        uint40 releaseAfter = v.degraded
            ? uint40(vm.getBlockTimestamp() + vault.DEGRADED_WINDOW())
            : v.coverage.expiresAt + vault.params().grace;

        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.CoverageLocked(
            v.coverage.coverageId,
            v.coverage.agentId,
            v.coverage.merchant,
            v.coverage.amount,
            v.coverage.premium,
            releaseAfter,
            v.coverage.mandateHash,
            v.coverage.amberCommitment,
            v.digest,
            v.userKeyHash,
            v.degraded
        );
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.PremiumPaid(v.coverage.coverageId, v.coverage.agentId, v.coverage.premium);
        vm.prank(makeAddr("relayer"));
        _lock(v, sig);
        uint256 gas = _executionGas(_lockCalldata(v, sig));
        emit log_named_uint(string.concat("lockCoverage execution, ", name), gas);
        emit log_named_uint(string.concat("lockCoverage transaction, ", name), vm.lastCallGas().gasTotalUsed);
        assertLe(gas, GAS_BUDGET, "lockCoverage gas");

        IKeelsonBondVault.CoverageState memory c = vault.coverages(v.coverage.coverageId);
        assertEq(c.amount, v.coverage.amount);
        assertEq(c.agentId, agentId);
        assertEq(c.releaseAfter, releaseAfter);
        assertEq(uint8(c.status), uint8(IKeelsonBondVault.Status.Active));
        assertEq(c.degraded, v.degraded);
        assertEq(vault.coverageHash(v.coverage.coverageId), KeelsonTypes.hash(v.coverage));
        IKeelsonBondVault.Bond memory b = _bond();
        assertEq(b.locked, v.coverage.amount);
        assertEq(b.free, deposited - v.coverage.amount - v.coverage.premium);
        assertEq(pyusd.balanceOf(reserve) - reserveBefore, v.coverage.premium);
        assertEq(pyusd.balanceOf(address(vault)), deposited - v.coverage.premium);
    }

    function test_lock_2of2_webauthn() public {
        _lockAndCheck(WEBAUTHN);
    }

    function test_lock_2of2_payment() public {
        _lockAndCheck(PAYMENT);
    }

    /// @dev Locked for at least 72 h, past its dispute window.
    function test_lock_degraded() public {
        _lockAndCheck(DEGRADED);
        Vector memory v = _vector(DEGRADED);
        assertGt(vault.coverages(v.coverage.coverageId).releaseAfter, v.coverage.expiresAt + vault.params().grace);
    }

    function _expectLockRevert(Vector memory v, bytes4 err) internal {
        bytes memory sig = _operatorSig(v.coverage);
        vm.expectRevert(err);
        _lock(v, sig);
    }

    function _at(string memory name) internal returns (Vector memory v) {
        v = _vector(name);
        vm.warp(v.countersign.issuedAt);
    }

    // A coverage the user never approved.

    function test_lock_otherMandateRevert() public {
        Vector memory v = _at(PAYMENT);
        v.hSd = _vector(WEBAUTHN).hSd;
        _expectLockRevert(v, IKeelsonBondVault.InvalidUserAssertion.selector);
    }

    function test_lock_userNotVerifiedReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.assertion.authenticatorData[32] ^= 0x04;
        _expectLockRevert(v, IKeelsonBondVault.InvalidUserAssertion.selector);
    }

    function test_lock_highSUnnormalizedReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.assertion.s = bytes32(P256_N - uint256(v.assertion.s));
        _expectLockRevert(v, IKeelsonBondVault.InvalidUserAssertion.selector);
    }

    function test_lock_otherKeyReverts() public {
        Vector memory v = _at(WEBAUTHN);
        Vector memory other = _vector(PAYMENT);
        (v.qx, v.qy) = (other.qx, other.qy);
        _expectLockRevert(v, IKeelsonBondVault.InvalidUserAssertion.selector);
    }

    /// @dev Anyone can read `M` and the signatures from a pending transaction and sign `M` with a key of their own.
    function _substituteKey(Vector memory v) internal pure returns (Vector memory) {
        uint256 pk = uint256(keccak256("someone else's passkey")) % P256_N;
        (uint256 qx, uint256 qy) = vm.publicKeyP256(pk);
        bytes32 message =
            sha256(abi.encodePacked(v.assertion.authenticatorData, sha256(bytes(v.assertion.clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, message);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        (v.qx, v.qy, v.assertion.r, v.assertion.s) = (bytes32(qx), bytes32(qy), r, s);
        return v;
    }

    function test_lock_substitutedKeyReverts() public {
        Vector memory v = _at(WEBAUTHN);
        bytes memory sig = _operatorSig(v.coverage);
        Vector memory forged = _substituteKey(_vector(WEBAUTHN));
        vm.expectRevert(IKeelsonBondVault.InvalidUserAssertion.selector);
        vm.prank(makeAddr("front-runner"));
        _lock(forged, sig);

        _lock(v, sig);
        assertEq(uint8(vault.coverages(v.coverage.coverageId).status), uint8(IKeelsonBondVault.Status.Active));
    }

    /// @dev The substituted assertion is valid: only the operator-signed `userKeyHash` stops it.
    function test_lock_substitutedKeyLocksOnlyIfOperatorSignedIt() public {
        Vector memory forged = _substituteKey(_at(WEBAUTHN));
        forged.coverage.userKeyHash = keccak256(abi.encodePacked(forged.qx, forged.qy));
        _lock(forged);
        assertEq(uint8(vault.coverages(forged.coverage.coverageId).status), uint8(IKeelsonBondVault.Status.Active));
    }

    // A coverage the TEEs never countersigned, or countersigned for something else.

    function test_lock_denyReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.countersign.decision = 2;
        _expectLockRevert(v, IKeelsonBondVault.CountersignMismatch.selector);
    }

    function test_lock_expiredCountersignReverts() public {
        Vector memory v = _at(WEBAUTHN);
        vm.warp(uint256(v.countersign.expiresAt) + 1);
        _expectLockRevert(v, IKeelsonBondVault.Expired.selector);
    }

    function test_lock_amountMismatchReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.coverage.amount += 1;
        _expectLockRevert(v, IKeelsonBondVault.CountersignMismatch.selector);
    }

    function test_lock_agentMismatchReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.coverage.agentId += 1;
        _expectLockRevert(v, IKeelsonBondVault.CountersignMismatch.selector);
    }

    function test_lock_requestMismatchReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.coverage.coverageId = keccak256("another purchase");
        _expectLockRevert(v, IKeelsonBondVault.CountersignMismatch.selector);
    }

    function test_lock_currencyMismatchReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.countersign.currency = 978;
        _expectLockRevert(v, IKeelsonBondVault.CountersignMismatch.selector);
    }

    function test_lock_mandateMismatchReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.coverage.mandateHash = _vector(PAYMENT).coverage.mandateHash;
        _expectLockRevert(v, IKeelsonBondVault.CountersignMismatch.selector);
    }

    function test_lock_premiumOverAmountReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.coverage.premium = v.coverage.amount + 1;
        _expectLockRevert(v, IKeelsonBondVault.CountersignMismatch.selector);
    }

    function test_lock_windowShorterThanDisputeReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.coverage.expiresAt -= 1;
        _expectLockRevert(v, IKeelsonBondVault.WindowTooShort.selector);
    }

    function test_lock_sameIdTwiceReverts() public {
        Vector memory v = _at(WEBAUTHN);
        _lock(v);
        _expectLockRevert(v, IKeelsonBondVault.CoverageExists.selector);
    }

    function test_lock_swappedSignaturesRevert() public {
        Vector memory v = _at(WEBAUTHN);
        v.countersigs = bytes.concat(v.nitro, v.tdx);
        _expectLockRevert(v, IKeelsonBondVault.InvalidCountersignature.selector);
    }

    function test_lock_degradedWithNitroSignatureReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.countersigs = v.nitro;
        _expectLockRevert(v, IKeelsonBondVault.InvalidCountersignature.selector);
    }

    function test_lock_unregisteredSignerReverts() public {
        Vector memory v = _at(WEBAUTHN);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(uint256(keccak256("not a tee signer")), v.digest);
        v.countersigs = bytes.concat(v.tdx, abi.encodePacked(r, s, sv));
        _expectLockRevert(v, IKeelsonBondVault.InvalidCountersignature.selector);
    }

    function test_lock_97ByteBlobReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.countersigs = bytes.concat(v.tdx, new bytes(32));
        _expectLockRevert(v, IKeelsonBondVault.InvalidCountersignature.selector);
    }

    // The operator's signature.

    function test_lock_operatorSigFromAgentWallet() public {
        Vector memory v = _at(WEBAUTHN);
        (address wallet, uint256 walletKey) = makeAddrAndKey("agent wallet");
        _setAgentWallet(wallet, walletKey);
        _lock(v, _signVault(walletKey, KeelsonTypes.hash(v.coverage)));
        assertEq(uint8(vault.coverages(v.coverage.coverageId).status), uint8(IKeelsonBondVault.Status.Active));
    }

    function test_lock_operatorSigFromOtherReverts() public {
        Vector memory v = _at(WEBAUTHN);
        (, uint256 funderKey) = _funder(1);
        bytes memory sig = _signVault(funderKey, KeelsonTypes.hash(v.coverage));
        vm.expectRevert(IKeelsonBondVault.InvalidOperatorSignature.selector);
        _lock(v, sig);
    }

    /// @dev ERC-8004 v2.0.0: the owner sets a wallet that signed `AgentWalletSet` under the registry's domain.
    function _setAgentWallet(address wallet, uint256 walletKey) internal {
        address identity = address(_identity());
        uint256 deadline = vm.getBlockTimestamp() + 60;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                identity
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"),
                agentId,
                wallet,
                operator,
                deadline
            )
        );
        (uint8 sv, bytes32 r, bytes32 s) =
            vm.sign(walletKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        vm.prank(operator);
        (bool ok,) = identity.call(
            abi.encodeWithSignature(
                "setAgentWallet(uint256,address,uint256,bytes)", agentId, wallet, deadline, abi.encodePacked(r, s, sv)
            )
        );
        assertTrue(ok, "setAgentWallet");
        assertEq(_identity().getAgentWallet(agentId), wallet);
    }

    // Pauses and the bond.

    function test_lock_whenPausedReverts() public {
        Vector memory v = _at(WEBAUTHN);
        vm.prank(_json().readAddress(".contracts.GuardianSafe"));
        vault.pause();
        _expectLockRevert(v, Pausable.EnforcedPause.selector);
    }

    function test_lock_insufficientBondReverts() public {
        Vector memory v = _at(WEBAUTHN);
        v.coverage.premium = uint96(deposited - v.coverage.amount + 1);
        _expectLockRevert(v, IKeelsonBondVault.InsufficientBond.selector);
    }

    /// @dev A paused PYUSD cannot pay the premium, so nothing is locked.
    function test_lock_tokenPausedReverts() public {
        Vector memory v = _at(WEBAUTHN);
        vm.prank(_json().readAddress(".external.pyusdAssetProtector"));
        pyusd.pause();
        bytes memory sig = _operatorSig(v.coverage);
        vm.expectRevert();
        _lock(v, sig);
        assertEq(uint8(vault.coverages(v.coverage.coverageId).status), uint8(IKeelsonBondVault.Status.None));
        assertEq(_bond().free, deposited);
        assertEq(_bond().locked, 0);
    }
}
