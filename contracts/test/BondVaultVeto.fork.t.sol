// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../script/CoverageVector.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {SlashBase} from "./utils/SlashBase.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";
import {RateLimiter} from "@openzeppelin/contracts/utils/RateLimiter.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Slashes that wait: above the instant cap, on a degraded coverage or verdict, or beyond the rate limit; the
/// Guardian's veto; and how a queued slash holds back releases and withdrawals.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract BondVaultVetoForkTest is SlashBase {
    using stdJson for string;

    uint96 internal constant AMOUNT = 50e6;

    address internal guardian;

    function setUp() public override {
        super.setUp();
        guardian = _json().readAddress(".contracts.GuardianSafe");
    }

    function _lowerCap(uint96 cap) internal {
        IKeelsonBondVault.Params memory p = vault.params();
        p.instantSlashCap = cap;
        _viaTimelock(address(vault), abi.encodeCall(vault.setParams, (p)));
    }

    /// @dev Locks the coverage, lowers the cap and queues a 50 PYUSD slash.
    function _queued() internal returns (Vector memory v, KeelsonTypes.Verdict memory verdict) {
        v = _locked(WEBAUTHN);
        _lowerCap(10e6);
        verdict = _amber(v, AMOUNT);
        bytes memory sigs = _sign2of2(verdict);
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.SlashQueued(
            verdict.disputeId,
            verdict.coverageId,
            agentId,
            AMOUNT,
            uint40(vm.getBlockTimestamp() + vault.params().vetoWindow),
            false,
            _digest(verdict)
        );
        vault.slash(verdict, treeSize, sigs);
        emit log_named_uint(
            "slash queued execution", _executionGas(abi.encodeCall(vault.slash, (verdict, treeSize, sigs)))
        );
    }

    function test_slash_aboveCapQueues() public {
        (Vector memory v, KeelsonTypes.Verdict memory verdict) = _queued();
        IKeelsonBondVault.QueuedSlash memory q = vault.queuedSlashes(verdict.disputeId);
        assertEq(uint8(q.status), uint8(IKeelsonBondVault.SlashStatus.Queued));
        assertEq(q.verdictDigest, _digest(verdict));
        assertEq(vault.pendingSlashes(agentId), 1);
        assertEq(vault.coverages(v.coverage.coverageId).pendingSlashes, 1);
        assertEq(pyusd.balanceOf(merchant), 0);

        vm.warp(q.readyAt - 1);
        vm.expectRevert(IKeelsonBondVault.NotReady.selector);
        vault.executeSlash(verdict.disputeId);

        vm.warp(q.readyAt);
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.Slashed(
            verdict.disputeId,
            verdict.coverageId,
            agentId,
            merchant,
            AMOUNT,
            VARIANT_FIELD,
            verdict.evidenceHash,
            _digest(verdict)
        );
        vm.prank(makeAddr("anyone"));
        vault.executeSlash(verdict.disputeId);
        emit log_named_uint(
            "executeSlash execution", _executionGas(abi.encodeCall(vault.executeSlash, (verdict.disputeId)))
        );
        assertEq(pyusd.balanceOf(merchant), AMOUNT);
        assertEq(vault.pendingSlashes(agentId), 0);
        assertEq(vault.coverages(v.coverage.coverageId).pendingSlashes, 0);
        assertEq(_bond().slashCount, 1);
        _assertBacked();
    }

    /// @dev A coverage the TDX leg countersigned alone queues every slash for 72 h, whatever its size.
    function test_slash_degradedCoverageQueues72h() public {
        Vector memory v = _locked(DEGRADED);
        KeelsonTypes.Verdict memory verdict = _amber(v, 1e6);
        _slash(verdict);
        IKeelsonBondVault.QueuedSlash memory q = vault.queuedSlashes(verdict.disputeId);
        assertEq(q.readyAt, vm.getBlockTimestamp() + vault.DEGRADED_WINDOW());

        vm.warp(q.readyAt - 1);
        vm.expectRevert(IKeelsonBondVault.NotReady.selector);
        vault.executeSlash(verdict.disputeId);
        vm.warp(q.readyAt);
        vault.executeSlash(verdict.disputeId);
        assertEq(pyusd.balanceOf(merchant), 1e6);
    }

    /// @dev A verdict signed by the TDX leg alone, on a 2-of-2 coverage.
    function test_slash_degradedVerdictQueues72h() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _amber(v, 1e6);
        bytes memory sig = _signDegraded(verdict);
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.SlashQueued(
            verdict.disputeId,
            verdict.coverageId,
            agentId,
            1e6,
            uint40(vm.getBlockTimestamp() + vault.DEGRADED_WINDOW()),
            true,
            _digest(verdict)
        );
        vault.slash(verdict, treeSize, sig);
        assertEq(pyusd.balanceOf(merchant), 0);
    }

    /// @dev I9: a veto restores the coverage and moves nothing; the dispute stays settled.
    function test_veto() public {
        (Vector memory v, KeelsonTypes.Verdict memory verdict) = _queued();
        uint256 vaultBalance = pyusd.balanceOf(address(vault));
        IKeelsonBondVault.Bond memory before = _bond();

        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.SlashVetoed(verdict.disputeId, "compromised leg");
        vm.prank(guardian);
        vault.vetoSlash(verdict.disputeId, "compromised leg");
        emit log_named_uint(
            "vetoSlash execution",
            _executionGas(abi.encodeCall(vault.vetoSlash, (verdict.disputeId, "compromised leg")))
        );
        assertEq(vault.slashed(v.coverage.coverageId), 0);
        assertEq(uint8(vault.queuedSlashes(verdict.disputeId).status), uint8(IKeelsonBondVault.SlashStatus.Vetoed));
        assertEq(vault.pendingSlashes(agentId), 0);
        assertEq(pyusd.balanceOf(address(vault)), vaultBalance);
        assertEq(abi.encode(_bond()), abi.encode(before));

        vm.expectRevert(IKeelsonBondVault.NotQueued.selector);
        vault.executeSlash(verdict.disputeId);

        bytes memory sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonBondVault.AlreadySettled.selector);
        vault.slash(verdict, treeSize, sigs);

        vm.warp(uint256(vault.coverages(v.coverage.coverageId).releaseAfter) + 1);
        vault.releaseCoverage(v.coverage.coverageId);
        assertEq(_bond().locked, 0);
        assertEq(_bond().free, deposited - v.coverage.premium);
    }

    function test_veto_afterReadyAtReverts() public {
        (, KeelsonTypes.Verdict memory verdict) = _queued();
        vm.warp(vault.queuedSlashes(verdict.disputeId).readyAt);
        vm.prank(guardian);
        vm.expectRevert(IKeelsonBondVault.VetoClosed.selector);
        vault.vetoSlash(verdict.disputeId, "late");
    }

    function test_veto_onlyGuardian() public {
        (, KeelsonTypes.Verdict memory verdict) = _queued();
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, stranger));
        vault.vetoSlash(verdict.disputeId, "not mine to veto");
    }

    function test_execute_twiceReverts() public {
        (, KeelsonTypes.Verdict memory verdict) = _queued();
        vm.warp(vault.queuedSlashes(verdict.disputeId).readyAt);
        vault.executeSlash(verdict.disputeId);
        vm.expectRevert(IKeelsonBondVault.NotQueued.selector);
        vault.executeSlash(verdict.disputeId);
        vm.prank(guardian);
        vm.expectRevert(IKeelsonBondVault.NotQueued.selector);
        vault.vetoSlash(verdict.disputeId, "after the fact");
    }

    /// @dev A compromised TEE signing a burst of valid verdicts: payouts stop at the rate limit, the rest queue for the
    /// Guardian. Scaled to the faucet PYUSD the fork holds: a 20 PYUSD bucket and 25 verdicts of 2 PYUSD.
    function test_rateLimit_burstQueuesTheRest() public {
        Vector memory v = _locked(WEBAUTHN);
        _viaTimelock(address(vault), abi.encodeCall(vault.setRateLimit, (1 hours, 20e6)));
        assertEq(vault.rateLimitAvailable(), 20e6);
        bytes32[] memory disputes = new bytes32[](25);
        for (uint256 i; i < 25; ++i) {
            KeelsonTypes.Verdict memory verdict = _verdict(v, 2e6, OPERATOR, string.concat("PP-D-", vm.toString(i)));
            disputes[i] = verdict.disputeId;
            _slash(verdict);
        }
        assertEq(pyusd.balanceOf(merchant), 20e6);
        assertEq(vault.pendingSlashes(agentId), 15);
        assertEq(uint8(vault.queuedSlashes(disputes[9]).status), uint8(IKeelsonBondVault.SlashStatus.None));
        assertEq(uint8(vault.queuedSlashes(disputes[10]).status), uint8(IKeelsonBondVault.SlashStatus.Queued));

        vm.prank(guardian);
        vault.vetoSlash(disputes[24], "burst");

        vm.warp(vault.queuedSlashes(disputes[10]).readyAt);
        vm.expectRevert(RateLimiter.RateLimitExceeded.selector);
        vault.executeSlash(disputes[10]);

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        for (uint256 i = 10; i < 20; ++i) {
            vault.executeSlash(disputes[i]);
        }
        vm.expectRevert(RateLimiter.RateLimitExceeded.selector);
        vault.executeSlash(disputes[20]);
        assertEq(pyusd.balanceOf(merchant), 40e6);
        _assertBacked();
    }

    function test_release_withPendingSlashReverts() public {
        (Vector memory v, KeelsonTypes.Verdict memory verdict) = _queued();
        vm.warp(uint256(vault.coverages(v.coverage.coverageId).releaseAfter) + 1);
        vm.expectRevert(IKeelsonBondVault.SlashPending.selector);
        vault.releaseCoverage(v.coverage.coverageId);

        vault.executeSlash(verdict.disputeId);
        vault.releaseCoverage(v.coverage.coverageId);
        assertEq(_bond().locked, 0);
        assertEq(_bond().free, deposited - v.coverage.premium - AMOUNT);
    }

    /// @dev A withdrawal waits while a slash is queued, and pays once it executed.
    function test_withdrawal_blockedWhileQueued_thenPaysMin() public {
        (, KeelsonTypes.Verdict memory verdict) = _queued();
        address to = makeAddr("operator treasury");
        uint128 amount = 5e6;
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signVault(operatorKey, KeelsonTypes.hashWithdrawal(agentId, amount, to, 0, deadline));
        uint256 id = vault.requestWithdrawal(agentId, amount, to, 0, deadline, sig);

        vm.warp(vault.withdrawals(id).readyAt);
        assertGe(vm.getBlockTimestamp(), vault.queuedSlashes(verdict.disputeId).readyAt);
        vm.expectRevert(IKeelsonBondVault.SlashPending.selector);
        vault.completeWithdrawal(id);

        vault.executeSlash(verdict.disputeId);
        vault.completeWithdrawal(id);
        assertEq(pyusd.balanceOf(to), amount);
        assertEq(_bond().queued, 0);
        _assertBacked();
    }

    /// @dev I9: a pause stops new coverage only; slashes, executions and claims go on.
    function test_pause_doesNotBlockSlashExecuteOrClaim() public {
        (Vector memory v, KeelsonTypes.Verdict memory queued) = _queued();
        vm.prank(guardian);
        vault.pause();

        _freeze(merchant);
        _slash(_verdict(v, 5e6, OPERATOR, "PP-D-while-paused"));
        assertEq(vault.claimable(merchant), 5e6);

        vm.warp(vault.queuedSlashes(queued.disputeId).readyAt);
        vault.executeSlash(queued.disputeId);
        assertEq(vault.claimable(merchant), 5e6 + AMOUNT);

        address fresh = makeAddr("merchant's new account");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(merchantKey, merchant, fresh, 0, deadline, vault.domainSeparator());
        vault.claim(merchant, fresh, 0, deadline, sig);
        assertEq(pyusd.balanceOf(fresh), 5e6 + AMOUNT);
    }

    /// @dev A queued slash larger than the whole bucket still executes: it takes the full bucket.
    function test_execute_slashLargerThanTheBucket() public {
        (, KeelsonTypes.Verdict memory verdict) = _queued();
        _viaTimelock(address(vault), abi.encodeCall(vault.setRateLimit, (1 hours, 20e6)));
        vm.warp(vault.queuedSlashes(verdict.disputeId).readyAt + 1 hours);
        vault.executeSlash(verdict.disputeId);
        assertEq(pyusd.balanceOf(merchant), AMOUNT);
        assertEq(vault.rateLimitAvailable(), 0);
    }

    /// @dev A zero-amount verdict would queue for 72 h and hold back withdrawals at no cost to the coverage.
    function test_slash_zeroAmountOrPayeeReverts() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _amber(v, 0);
        bytes memory sig = _signDegraded(verdict);
        vm.expectRevert(IKeelsonBondVault.ZeroAmount.selector);
        vault.slash(verdict, treeSize, sig);

        verdict = _amber(v, 1e6);
        verdict.payee = address(0);
        sig = _sign2of2(verdict);
        vm.expectRevert(IKeelsonBondVault.ZeroAmount.selector);
        vault.slash(verdict, treeSize, sig);
    }
}
