// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../script/CoverageVector.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {LockBase} from "./utils/VaultBase.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Release, the withdrawal queue and payout addresses, after real coverages locked on a fork of Arbitrum
/// Sepolia.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract BondVaultLifecycleForkTest is LockBase {
    using stdJson for string;

    uint256 internal deposited;
    address internal recipient = makeAddr("operator treasury");

    function setUp() public override {
        super.setUp();
        deposited = _depositAll();
    }

    function _locked(string memory name) internal returns (Vector memory v) {
        v = _vector(name);
        vm.warp(v.countersign.issuedAt);
        _lock(v);
    }

    // Release.

    function test_release_onlyAfterExpiryAndGrace() public {
        Vector memory v = _locked(WEBAUTHN);
        uint40 releaseAfter = vault.coverages(v.coverage.coverageId).releaseAfter;
        assertEq(releaseAfter, v.coverage.expiresAt + vault.params().grace);
        vm.warp(releaseAfter);
        vm.expectRevert(IKeelsonBondVault.NotReleasable.selector);
        vault.releaseCoverage(v.coverage.coverageId);

        vm.warp(uint256(releaseAfter) + 1);
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.CoverageReleased(v.coverage.coverageId, agentId, v.coverage.amount);
        vm.prank(makeAddr("anyone"));
        vault.releaseCoverage(v.coverage.coverageId);
        uint256 gReleasecoverage = _executionGas(abi.encodeCall(vault.releaseCoverage, (v.coverage.coverageId)));
        emit log_named_uint("releaseCoverage execution", gReleasecoverage);
        GasBudget.check("releaseCoverage", gReleasecoverage);
        assertEq(_bond().locked, 0);
        assertEq(_bond().free, deposited - v.coverage.premium);
        assertEq(uint8(vault.coverages(v.coverage.coverageId).status), uint8(IKeelsonBondVault.Status.Released));

        vm.expectRevert(IKeelsonBondVault.NotReleasable.selector);
        vault.releaseCoverage(v.coverage.coverageId);
    }

    function test_release_degradedOnlyAfter72Hours() public {
        Vector memory v = _locked(DEGRADED);
        vm.warp(uint256(v.coverage.expiresAt) + vault.params().grace + 1);
        vm.expectRevert(IKeelsonBondVault.NotReleasable.selector);
        vault.releaseCoverage(v.coverage.coverageId);
        vm.warp(uint256(v.countersign.issuedAt) + vault.DEGRADED_WINDOW() + 1);
        vault.releaseCoverage(v.coverage.coverageId);
        assertEq(_bond().locked, 0);
    }

    function test_release_whilePaused() public {
        Vector memory v = _locked(PAYMENT);
        vm.prank(_json().readAddress(".contracts.GuardianSafe"));
        vault.pause();
        vm.warp(uint256(vault.coverages(v.coverage.coverageId).releaseAfter) + 1);
        vault.releaseCoverage(v.coverage.coverageId);
        assertEq(_bond().locked, 0);
    }

    function test_release_unknownReverts() public {
        vm.expectRevert(IKeelsonBondVault.NotReleasable.selector);
        vault.releaseCoverage(keccak256("never locked"));
    }

    // Withdrawals.

    function _withdrawalSig(uint256 pk, uint128 amount, address to, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _signVault(pk, KeelsonTypes.hashWithdrawal(agentId, amount, to, nonce, deadline));
    }

    function _request(uint128 amount) internal returns (uint256 id) {
        uint256 nonce = vault.nonces(operator);
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _withdrawalSig(operatorKey, amount, recipient, nonce, deadline);
        id = vault.requestWithdrawal(agentId, amount, recipient, nonce, deadline, sig);
        uint256 gas =
            _executionGas(abi.encodeCall(vault.requestWithdrawal, (agentId, amount, recipient, nonce, deadline, sig)));
        emit log_named_uint(string.concat("requestWithdrawal execution, request #", vm.toString(id)), gas);
        if (id <= 2) GasBudget.check(id == 1 ? "requestWithdrawal_first" : "requestWithdrawal_later", gas);
    }

    function test_withdrawal_paysTheSignedRecipientAfterTheDelay() public {
        uint128 amount = 10e6;
        uint40 readyAt = uint40(vm.getBlockTimestamp() + vault.params().withdrawalDelay);
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.WithdrawalQueued(1, agentId, amount, recipient, readyAt);
        uint256 id = _request(amount);
        assertEq(_bond().free, deposited - amount);
        assertEq(_bond().queued, amount);

        vm.warp(readyAt - 1);
        vm.expectRevert(IKeelsonBondVault.NotReady.selector);
        vault.completeWithdrawal(id);

        vm.warp(readyAt);
        vm.prank(makeAddr("anyone"));
        vault.completeWithdrawal(id);
        uint256 gCompletewithdrawalFirstrecipient = _executionGas(abi.encodeCall(vault.completeWithdrawal, (id)));
        emit log_named_uint("completeWithdrawal execution", gCompletewithdrawalFirstrecipient);
        GasBudget.check("completeWithdrawal_firstRecipient", gCompletewithdrawalFirstrecipient);
        assertEq(pyusd.balanceOf(recipient), amount);
        assertEq(pyusd.balanceOf(makeAddr("anyone")), 0);
        assertEq(_bond().queued, 0);

        vm.expectRevert(IKeelsonBondVault.UnknownWithdrawal.selector);
        vault.completeWithdrawal(id);

        id = _request(amount);
        vm.warp(vm.getBlockTimestamp() + vault.params().withdrawalDelay);
        vault.completeWithdrawal(id);
        uint256 gCompletewithdrawalKnownrecipient = _executionGas(abi.encodeCall(vault.completeWithdrawal, (id)));
        emit log_named_uint("completeWithdrawal execution, same recipient again", gCompletewithdrawalKnownrecipient);
        GasBudget.check("completeWithdrawal_knownRecipient", gCompletewithdrawalKnownrecipient);
    }

    function test_withdrawal_completesWhilePaused() public {
        uint256 id = _request(1e6);
        vm.prank(_json().readAddress(".contracts.GuardianSafe"));
        vault.pause();
        vm.warp(vm.getBlockTimestamp() + vault.params().withdrawalDelay);
        vault.completeWithdrawal(id);
        assertEq(pyusd.balanceOf(recipient), 1e6);
    }

    function test_withdrawal_fromNonAuthorityReverts() public {
        (, uint256 funderKey) = _funder(1);
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _withdrawalSig(funderKey, 1e6, recipient, 0, deadline);
        vm.expectRevert(IKeelsonBondVault.NotAgentAuthority.selector);
        vault.requestWithdrawal(agentId, 1e6, recipient, 0, deadline, sig);
    }

    function test_withdrawal_toOtherThanSignedReverts() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _withdrawalSig(operatorKey, 1e6, recipient, 0, deadline);
        vm.expectRevert(IKeelsonBondVault.NotAgentAuthority.selector);
        vault.requestWithdrawal(agentId, 1e6, makeAddr("thief"), 0, deadline, sig);
    }

    function test_withdrawal_replayReverts() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _withdrawalSig(operatorKey, 1e6, recipient, 0, deadline);
        vault.requestWithdrawal(agentId, 1e6, recipient, 0, deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(Nonces.InvalidAccountNonce.selector, operator, 1));
        vault.requestWithdrawal(agentId, 1e6, recipient, 0, deadline, sig);
    }

    function test_withdrawal_expiredReverts() public {
        uint256 deadline = vm.getBlockTimestamp() - 1;
        bytes memory sig = _withdrawalSig(operatorKey, 1e6, recipient, 0, deadline);
        vm.expectRevert(IKeelsonBondVault.Expired.selector);
        vault.requestWithdrawal(agentId, 1e6, recipient, 0, deadline, sig);
    }

    function test_withdrawal_overFreeReverts() public {
        Vector memory v = _locked(WEBAUTHN);
        uint128 free = _bond().free;
        assertEq(free, deposited - v.coverage.amount - v.coverage.premium);
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _withdrawalSig(operatorKey, free + 1, recipient, 0, deadline);
        vm.expectRevert(IKeelsonBondVault.InsufficientBond.selector);
        vault.requestWithdrawal(agentId, free + 1, recipient, 0, deadline, sig);
    }

    // Payout addresses.

    function test_setPayoutAddress() public {
        (address merchant, uint256 merchantKey) = makeAddrAndKey("merchant");
        address payout = makeAddr("merchant payout");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signVault(merchantKey, KeelsonTypes.hashPayoutAddress(merchant, payout, 0, deadline));
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.PayoutAddressSet(merchant, payout);
        vault.setPayoutAddress(merchant, payout, 0, deadline, sig);
        assertEq(vault.payoutAddress(merchant), payout);

        vm.expectRevert(abi.encodeWithSelector(Nonces.InvalidAccountNonce.selector, merchant, 1));
        vault.setPayoutAddress(merchant, payout, 0, deadline, sig);

        vm.expectRevert(IKeelsonBondVault.InvalidSignature.selector);
        vault.setPayoutAddress(merchant, makeAddr("thief"), 1, deadline, sig);
    }

    /// @dev A payout signature is valid through its deadline's second, not after it.
    function test_setPayoutAddress_deadlineBoundary() public {
        (address merchant, uint256 merchantKey) = makeAddrAndKey("merchant");
        address payout = makeAddr("merchant payout");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signVault(merchantKey, KeelsonTypes.hashPayoutAddress(merchant, payout, 0, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(IKeelsonBondVault.Expired.selector);
        vault.setPayoutAddress(merchant, payout, 0, deadline, sig);
        vm.warp(deadline);
        vault.setPayoutAddress(merchant, payout, 0, deadline, sig);
        assertEq(vault.payoutAddress(merchant), payout);
    }
}
