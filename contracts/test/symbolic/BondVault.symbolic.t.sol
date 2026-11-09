// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IKeelsonBondVault} from "../../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {SymbolicSetup} from "./SymbolicSetup.sol";

/// @notice Bounded symbolic checks of the vault's slashing and withdrawal guards, for Halmos and `forge test --symbolic`.
contract BondVaultSymbolicTest is SymbolicSetup {
    /// @notice I1: a slash with arbitrary signature bytes succeeds only if they recover to the active TDX signer and,
    /// for two signatures, the active Nitro signer.
    function check_slashRequiresSignatures(bytes calldata sigs) public {
        KeelsonTypes.Verdict memory v = _verdict(keccak256("dispute"), COVERAGE, 1e6, OPERATOR);
        bytes32 digest = _digest(v);
        if (_slash(v, sigs)) {
            assert(sigs.length == 65 || sigs.length == 130);
            assert(_recover(digest, sigs[0:65]) == tdx);
            if (sigs.length == 130) assert(_recover(digest, sigs[65:130]) == nitro);
        }
    }

    /// @notice I2: once a dispute settled through `slash`, neither another slash nor a warranty settles it again.
    function check_noDoubleSettle(bytes32 disputeId, uint96 secondAmount, bool degradedFirst) public {
        KeelsonTypes.Verdict memory first = _verdict(disputeId, COVERAGE, 1e6, OPERATOR);
        bytes32 digest = _digest(first);
        vm.assume(_slash(first, degradedFirst ? _signWith(TDX_KEY, digest) : _sign2of2(digest)));
        assert(vault.settled(disputeId));

        KeelsonTypes.Verdict memory again = _verdict(disputeId, COVERAGE, secondAmount, OPERATOR);
        assert(!_slash(again, _sign2of2(_digest(again))));
        KeelsonTypes.Verdict memory warranty = _verdict(disputeId, COVERAGE, secondAmount, KEELSON);
        assert(!_payWarranty(warranty, _sign2of2(_digest(warranty))));
    }

    /// @notice I3: two slashes of one coverage never take more than its amount, and neither does a slash with a warranty,
    /// in either order.
    function check_slashWithinCoverage(uint96 a, uint96 b) public {
        KeelsonTypes.Verdict memory first = _verdict(keccak256("dispute a"), COVERAGE, a, OPERATOR);
        KeelsonTypes.Verdict memory second = _verdict(keccak256("dispute b"), COVERAGE, b, OPERATOR);
        _slash(first, _sign2of2(_digest(first)));
        _slash(second, _sign2of2(_digest(second)));
        assert(vault.slashed(COVERAGE) <= COVERAGE_AMOUNT);
    }

    function check_slashAndWarrantyWithinCoverage(uint96 a, uint96 w, bool warrantyFirst) public {
        KeelsonTypes.Verdict memory slash = _verdict(keccak256("dispute a"), COVERAGE, a, OPERATOR);
        KeelsonTypes.Verdict memory warranty = _verdict(keccak256("dispute w"), COVERAGE, w, KEELSON);
        if (warrantyFirst) _payWarranty(warranty, _sign2of2(_digest(warranty)));
        _slash(slash, _sign2of2(_digest(slash)));
        if (!warrantyFirst) _payWarranty(warranty, _sign2of2(_digest(warranty)));
        assert(uint256(vault.slashed(COVERAGE)) + reserve.warranted(COVERAGE) <= COVERAGE_AMOUNT);
    }

    /// @notice I7: an instant slash pays the payee exactly the verdict's amount, or credits it exactly to its claimable.
    function check_slashPaysPayee(uint96 amount) public {
        KeelsonTypes.Verdict memory v = _verdict(keccak256("dispute"), COVERAGE, amount, OPERATOR);
        uint256 balance = token.balanceOf(MERCHANT);
        uint256 claimable = vault.claimable(MERCHANT);
        vm.assume(_slash(v, _sign2of2(_digest(v))));

        uint256 paid = token.balanceOf(MERCHANT) - balance + vault.claimable(MERCHANT) - claimable;
        if (_queued(v.disputeId).status == IKeelsonBondVault.SlashStatus.Queued) {
            assert(paid == 0);
            vm.warp(block.timestamp + VETO_WINDOW);
            vault.executeSlash(v.disputeId);
            paid = token.balanceOf(MERCHANT) - balance + vault.claimable(MERCHANT) - claimable;
        }
        assert(paid == amount);
    }

    /// @notice LIA: a slash succeeds only for a verdict naming the operator liable.
    function check_liable(uint8 liable) public {
        KeelsonTypes.Verdict memory v = _verdict(keccak256("dispute"), COVERAGE, 1e6, liable);
        if (_slash(v, _sign2of2(_digest(v)))) assert(liable == OPERATOR);
    }

    /// @notice DEG1: a lone Nitro signature never slashes, and the verifier never accepts it as degraded.
    function check_degradedOnlyTdx(bytes32 digest) public {
        assert(!verifier.verifyDegraded(digest, _signWith(NITRO_KEY, digest)));
        KeelsonTypes.Verdict memory v = _verdict(svm.createBytes32("disputeId"), COVERAGE, 1e6, OPERATOR);
        assert(!_slash(v, _signWith(NITRO_KEY, _digest(v))));
    }

    /// @notice DEG2: a degraded verdict, or any verdict against a degraded coverage, pays nothing at once and cannot be
    /// executed before 72 hours.
    function check_degradedQueued(uint96 amount, bool degradedVerdict, uint40 wait) public {
        bytes32 coverageId = degradedVerdict ? COVERAGE : DEGRADED_COVERAGE;
        KeelsonTypes.Verdict memory v = _verdict(keccak256("dispute"), coverageId, amount, OPERATOR);
        bytes32 digest = _digest(v);
        uint256 balance = token.balanceOf(MERCHANT);
        vm.assume(_slash(v, degradedVerdict ? _signWith(TDX_KEY, digest) : _sign2of2(digest)));

        IKeelsonBondVault.QueuedSlash memory q = _queued(v.disputeId);
        assert(q.status == IKeelsonBondVault.SlashStatus.Queued);
        assert(q.readyAt >= block.timestamp + 72 hours);
        assert(token.balanceOf(MERCHANT) == balance && vault.claimable(MERCHANT) == 0);

        vm.assume(wait < 72 hours);
        vm.warp(block.timestamp + wait);
        (bool executed,) = address(vault).call(abi.encodeCall(vault.executeSlash, (v.disputeId)));
        assert(!executed);
    }

    /// @notice I12 (bounded half): a queued slash keeps the digest of the verdict that was verified, which
    /// `executeSlash` emits in `Slashed`; the instant path emits the same digest it verified.
    function check_slashedCarriesDigest(uint96 amount) public {
        KeelsonTypes.Verdict memory v = _verdict(keccak256("dispute"), COVERAGE, amount, OPERATOR);
        bytes32 digest = _digest(v);
        vm.assume(_slash(v, _signWith(TDX_KEY, digest)));
        assert(_queued(v.disputeId).verdictDigest == digest);
    }

    /// @notice I5: a withdrawal completes only once it is ready and while no slash of its agent is pending.
    function check_completeWithdrawalGuards(uint40 readyAt, uint40 when, bool slashPending) public {
        vm.assume(readyAt > start && when >= start);
        _storeBond(FREE, 2 * COVERAGE_AMOUNT, 10e6);
        _storeWithdrawal(1, 10e6, readyAt, MERCHANT);
        if (slashPending) {
            KeelsonTypes.Verdict memory v = _verdict(keccak256("dispute"), COVERAGE, 1e6, OPERATOR);
            vm.assume(_slash(v, _signWith(TDX_KEY, _digest(v))));
            assert(vault.pendingSlashes(AGENT) == 1);
        }
        vm.warp(when);
        (bool ok,) = address(vault).call(abi.encodeCall(vault.completeWithdrawal, (1)));
        if (ok) assert(when >= readyAt && !slashPending);
    }
}
