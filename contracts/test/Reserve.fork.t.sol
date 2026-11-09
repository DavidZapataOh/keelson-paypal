// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../script/CoverageVector.sol";
import {KeelsonReserve} from "../src/KeelsonReserve.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {IKeelsonReserve} from "../src/interfaces/IKeelsonReserve.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {SlashBase} from "./utils/SlashBase.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {RateLimiter} from "@openzeppelin/contracts/utils/RateLimiter.sol";

/// @notice The warranty reserve on a fork of Arbitrum Sepolia: real PYUSD, premiums from coverages locked with the live
/// vectors, warranties on verdicts that name Keelson liable.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract ReserveForkTest is SlashBase {
    uint256 internal constant SEED = 100e6;
    uint96 internal constant AMOUNT = 30e6;

    address internal treasury;

    function setUp() public override {
        super.setUp();
        treasury = makeAddr("treasury");
        _fundFromHolder(treasury, SEED);
        _stake(treasury, SEED);
    }

    function _stake(address who, uint256 assets) internal returns (uint256 shares) {
        vm.startPrank(who);
        pyusd.approve(address(reserve), assets);
        shares = reserve.deposit(assets, who);
        vm.stopPrank();
    }

    function _green(Vector memory v, uint96 amount) internal view returns (KeelsonTypes.Verdict memory) {
        return _verdict(v, amount, KEELSON, "PP-D-green");
    }

    function _pay(KeelsonTypes.Verdict memory v) internal {
        reserve.payWarranty(v, treeSize, _sign2of2(v));
    }

    function test_premiumsRaiseSharePrice() public {
        uint256 shares = reserve.balanceOf(treasury);
        uint256 before = reserve.convertToAssets(shares);
        assertApproxEqAbs(before, SEED, 1);
        Vector memory v = _locked(WEBAUTHN);
        assertGt(reserve.convertToAssets(shares), before);
        assertApproxEqAbs(reserve.convertToAssets(shares), SEED + v.coverage.premium, 1);
        assertEq(reserve.decimals(), 12);
    }

    function test_payWarranty_green() public {
        Vector memory v = _locked(WEBAUTHN);
        uint256 assetsBefore = reserve.totalAssets();
        KeelsonTypes.Verdict memory verdict = _green(v, AMOUNT);
        bytes memory sigs = _sign2of2(verdict);
        vm.expectEmit(address(reserve));
        emit IKeelsonReserve.WarrantyPaid(verdict.disputeId, verdict.coverageId, merchant, AMOUNT, _digest(verdict));
        vm.prank(makeAddr("relayer"));
        reserve.payWarranty(verdict, treeSize, sigs);
        uint256 gPaywarranty = _executionGas(abi.encodeCall(reserve.payWarranty, (verdict, treeSize, sigs)));
        emit log_named_uint("payWarranty execution", gPaywarranty);
        GasBudget.check("payWarranty", gPaywarranty);
        assertEq(pyusd.balanceOf(merchant), AMOUNT);
        assertEq(reserve.totalAssets(), assetsBefore - AMOUNT);
        assertTrue(reserve.settled(verdict.disputeId));
    }

    function test_payWarranty_revertsUnlessKeelsonLiable() public {
        Vector memory v = _locked(WEBAUTHN);
        for (uint8 liable = 1; liable <= 4; ++liable) {
            if (liable == KEELSON) continue;
            KeelsonTypes.Verdict memory verdict = _verdict(v, AMOUNT, liable, "PP-D-other");
            bytes memory sigs = _sign2of2(verdict);
            vm.expectRevert(IKeelsonReserve.NotKeelsonLiable.selector);
            reserve.payWarranty(verdict, treeSize, sigs);
        }
    }

    function test_payWarranty_reuse() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _green(v, AMOUNT);
        _pay(verdict);
        bytes memory sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonReserve.AlreadySettled.selector);
        reserve.payWarranty(verdict, treeSize, sigs);
    }

    /// @dev I2 across both contracts: a dispute the vault slashed cannot also get a warranty, and the other way round,
    /// even if both legs signed both verdicts.
    function test_slashAndWarrantyShareTheNullifier() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory amber = _verdict(v, AMOUNT, OPERATOR, "PP-D-1");
        _slash(amber);
        KeelsonTypes.Verdict memory green = _verdict(v, AMOUNT, KEELSON, "PP-D-1");
        bytes memory sigs = _sign2of2(green);
        vm.expectRevert(IKeelsonReserve.AlreadySettled.selector);
        reserve.payWarranty(green, treeSize, sigs);

        green = _verdict(v, AMOUNT, KEELSON, "PP-D-2");
        _pay(green);
        amber = _verdict(v, AMOUNT, OPERATOR, "PP-D-2");
        sigs = _sign2of2(amber);
        vm.expectRevert(IKeelsonReserve.AlreadySettled.selector);
        vault.slash(amber, treeSize, sigs);
    }

    function test_payWarranty_degradedSignatureReverts() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _green(v, AMOUNT);
        bytes memory sig = _signDegraded(verdict);
        vm.expectRevert(IKeelsonReserve.InvalidVerdictSignature.selector);
        reserve.payWarranty(verdict, treeSize, sig);
    }

    function test_payWarranty_unknownCoverage() public {
        Vector memory v = _vector(WEBAUTHN);
        vm.warp(v.countersign.issuedAt);
        KeelsonTypes.Verdict memory verdict = _green(v, AMOUNT);
        bytes memory sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonReserve.UnknownCoverage.selector);
        reserve.payWarranty(verdict, treeSize, sigs);
    }

    function test_payWarranty_exceedsCoverage() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _green(v, v.coverage.amount + 1);
        bytes memory sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonReserve.ExceedsCoverage.selector);
        reserve.payWarranty(verdict, treeSize, sigs);

        _pay(_verdict(v, 60e6, KEELSON, "PP-D-a"));
        verdict = _verdict(v, 40e6, KEELSON, "PP-D-b");
        sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonReserve.ExceedsCoverage.selector);
        reserve.payWarranty(verdict, treeSize, sigs);
    }

    function test_payWarranty_insufficientReserve() public {
        Vector memory v = _locked(WEBAUTHN);
        vm.prank(treasury);
        reserve.requestCooldown();
        vm.warp(vm.getBlockTimestamp() + reserve.cooldown());
        uint256 shares = reserve.balanceOf(treasury);
        vm.prank(treasury);
        reserve.redeem(shares, treasury, treasury);
        KeelsonTypes.Verdict memory verdict = _green(v, AMOUNT);
        bytes memory sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonReserve.InsufficientReserve.selector);
        reserve.payWarranty(verdict, treeSize, sigs);
    }

    function test_payWarranty_unanchored() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _green(v, AMOUNT);
        verdict.checkpointRoot = keccak256("never anchored");
        bytes memory sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonReserve.NotAnchored.selector);
        reserve.payWarranty(verdict, treeSize, sigs);
    }

    function test_frozenPayeeGoesToClaimable() public {
        Vector memory v = _locked(WEBAUTHN);
        _freeze(merchant);
        uint256 assetsBefore = reserve.totalAssets();
        KeelsonTypes.Verdict memory verdict = _green(v, AMOUNT);
        vm.expectEmit(address(reserve));
        emit IKeelsonReserve.PayoutFailed(verdict.disputeId, merchant, AMOUNT);
        _pay(verdict);
        assertEq(reserve.claimable(merchant), AMOUNT);
        assertEq(reserve.totalClaimable(), AMOUNT);
        assertEq(reserve.totalAssets(), assetsBefore - AMOUNT);

        address fresh = makeAddr("merchant's new account");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(merchantKey, merchant, fresh, 0, deadline, reserve.domainSeparator());
        vm.prank(makeAddr("relayer"));
        reserve.claim(merchant, fresh, 0, deadline, sig);
        assertEq(pyusd.balanceOf(fresh), AMOUNT);
        assertEq(reserve.totalClaimable(), 0);
        assertEq(reserve.totalAssets(), assetsBefore - AMOUNT);
    }

    function test_withdraw_needsCooldown() public {
        uint256 shares = reserve.balanceOf(treasury);
        vm.startPrank(treasury);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, treasury, shares, 0));
        reserve.redeem(shares, treasury, treasury);

        reserve.requestCooldown();
        uint256 start = vm.getBlockTimestamp();
        vm.warp(start + reserve.cooldown() - 1);
        assertEq(reserve.maxRedeem(treasury), 0);
        vm.warp(start + reserve.cooldown() + reserve.unstakeWindow() + 1);
        assertEq(reserve.maxWithdraw(treasury), 0);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, treasury, shares, 0));
        reserve.redeem(shares, treasury, treasury);

        reserve.requestCooldown();
        vm.warp(vm.getBlockTimestamp() + reserve.cooldown());
        reserve.redeem(shares / 2, treasury, treasury);
        vm.stopPrank();
        assertApproxEqAbs(pyusd.balanceOf(treasury), SEED / 2, 1);
    }

    /// @dev Moving shares to an owner whose window is already open would skip the cooldown.
    function test_transferToCoolingOwnerReverts() public {
        address other = makeAddr("other staker");
        vm.prank(other);
        reserve.requestCooldown();
        vm.prank(treasury);
        vm.expectRevert(IKeelsonReserve.CooldownActive.selector);
        reserve.transfer(other, 1);
    }

    /// @dev OpenZeppelin's donation attack on a fresh reserve: with the 6-decimal virtual offset the attacker loses
    /// most of what it donates, and the victim keeps nearly all of its deposit.
    function test_firstDepositorInflationBounded() public {
        IERC4626 empty = new KeelsonReserve(
            IERC20(address(pyusd)),
            vault.verifier(),
            vault.anchor(),
            vault,
            vault.logOrigin(),
            address(this),
            10 minutes,
            1 days,
            1 hours,
            1_000e6
        );
        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");
        _fundFromHolder(attacker, 10_000e6 + 1);
        _fundFromHolder(victim, 1_000e6);

        vm.startPrank(attacker);
        pyusd.approve(address(empty), 1);
        empty.deposit(1, attacker);
        assertTrue(pyusd.transfer(address(empty), 10_000e6));
        vm.stopPrank();

        vm.startPrank(victim);
        pyusd.approve(address(empty), 1_000e6);
        uint256 shares = empty.deposit(1_000e6, victim);
        vm.stopPrank();
        assertGt(shares, 0);
        assertGe(empty.convertToAssets(shares), 1_000e6 * 999 / 1000, "victim keeps its deposit");
        assertLt(empty.convertToAssets(empty.balanceOf(attacker)), 10_000e6, "attacker loses its donation");
    }

    /// @dev One coverage pays at most its amount, whether the operator's bond or the reserve pays it.
    function test_slashAndWarrantyShareTheCoverage() public {
        Vector memory v = _locked(WEBAUTHN);
        _slash(_verdict(v, 60e6, OPERATOR, "PP-D-amber"));
        KeelsonTypes.Verdict memory green = _verdict(v, 40e6, KEELSON, "PP-D-green");
        bytes memory sigs = _sign2of2(green);
        vm.expectRevert(IKeelsonReserve.ExceedsCoverage.selector);
        reserve.payWarranty(green, treeSize, sigs);
        green.amount = v.coverage.amount - 60e6;
        _pay(green);

        KeelsonTypes.Verdict memory amber = _verdict(v, 1, OPERATOR, "PP-D-amber-2");
        sigs = _sign2of2(amber);
        vm.expectRevert(IKeelsonBondVault.ExceedsCoverage.selector);
        vault.slash(amber, treeSize, sigs);
    }

    /// @dev A burst of warranties stops at the reserve's rate limit.
    function test_payWarranty_rateLimited() public {
        Vector memory v = _locked(WEBAUTHN);
        _viaTimelock(address(reserve), abi.encodeCall(reserve.setRateLimit, (10 minutes, 20e6)));
        _pay(_verdict(v, 20e6, KEELSON, "PP-D-1"));
        KeelsonTypes.Verdict memory next = _verdict(v, 1e6, KEELSON, "PP-D-2");
        bytes memory sigs = _sign2of2(next);
        vm.expectRevert(RateLimiter.RateLimitExceeded.selector);
        reserve.payWarranty(next, treeSize, sigs);
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        next = _verdict(v, 1e6, KEELSON, "PP-D-2");
        _pay(next);
    }

    /// @dev Keelson's guarantee runs one dispute window past the release, no longer.
    function test_payWarranty_afterTheWindowReverts() public {
        Vector memory v = _locked(WEBAUTHN);
        uint256 closes = uint256(vault.coverages(v.coverage.coverageId).releaseAfter) + vault.params().disputeWindow;
        vm.warp(closes + 1);
        KeelsonTypes.Verdict memory green = _green(v, AMOUNT);
        bytes memory sigs = _sign2of2(green);
        vm.expectRevert(IKeelsonReserve.WarrantyWindowClosed.selector);
        reserve.payWarranty(green, treeSize, sigs);
        vm.warp(closes);
        green = _green(v, AMOUNT);
        _pay(green);
    }

    /// @dev Fresh deposits into an owner whose window is open would skip the cooldown too.
    function test_depositToCoolingOwnerReverts() public {
        address other = makeAddr("pre-cooled");
        vm.prank(other);
        reserve.requestCooldown();
        _fundFromHolder(other, 1e6);
        vm.startPrank(other);
        pyusd.approve(address(reserve), 1e6);
        vm.expectRevert(IKeelsonReserve.CooldownActive.selector);
        reserve.deposit(1e6, other);
        vm.stopPrank();
    }

    function test_payWarranty_paysThePayoutAddress() public {
        address payout = makeAddr("merchant payout");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", vault.domainSeparator(), KeelsonTypes.hashPayoutAddress(merchant, payout, 0, deadline)
            )
        );
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(merchantKey, digest);
        vault.setPayoutAddress(merchant, payout, 0, deadline, abi.encodePacked(r, s, sv));
        Vector memory v = _locked(WEBAUTHN);
        _pay(_green(v, AMOUNT));
        assertEq(pyusd.balanceOf(payout), AMOUNT);
        assertEq(pyusd.balanceOf(merchant), 0);
    }
}
