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
        _fulfil(treasury, reserve.balanceOf(treasury));
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

    /// @dev Requests `shares` of `owner` for itself, waits the cooldown and fulfils them.
    function _fulfil(address owner, uint256 shares) internal returns (uint256 assets) {
        vm.prank(owner);
        reserve.requestRedeem(shares, owner, owner);
        vm.warp(reserve.redeemReadyAt(owner));
        assets = reserve.fulfillRedeem(owner);
    }

    function _assertClaimsBacked() internal view {
        assertGe(pyusd.balanceOf(address(reserve)), reserve.totalClaimable() + reserve.totalClaimableRedeem());
    }

    function test_supportsTheErc7540Interfaces() public view {
        assertEq(
            IKeelsonReserve.isOperator.selector ^ IKeelsonReserve.setOperator.selector, bytes4(0xe3bc4e65), "operator"
        );
        assertEq(
            IKeelsonReserve.requestRedeem.selector ^ IKeelsonReserve.pendingRedeemRequest.selector
                ^ IKeelsonReserve.claimableRedeemRequest.selector,
            bytes4(0x620ee8e4),
            "async redeem"
        );
        assertTrue(reserve.supportsInterface(0xe3bc4e65));
        assertTrue(reserve.supportsInterface(0x620ee8e4));
        assertTrue(reserve.supportsInterface(0x2f0a18c5));
        assertTrue(reserve.supportsInterface(0x01ffc9a7));
        assertFalse(reserve.supportsInterface(0xce3bbe50), "deposits are synchronous");
        assertFalse(reserve.supportsInterface(0xffffffff));
        assertEq(reserve.share(), address(reserve));
    }

    function test_previewsOfARedemptionRevert() public {
        vm.expectRevert(IKeelsonReserve.AsyncRedeem.selector);
        reserve.previewRedeem(1e6);
        vm.expectRevert(IKeelsonReserve.AsyncRedeem.selector);
        reserve.previewWithdraw(1e6);
    }

    /// @dev Shares move into the reserve on request, wait exactly the cooldown, and are claimable once fulfilled.
    function test_requestThenFulfilAfterTheCooldown() public {
        uint256 shares = reserve.balanceOf(treasury);
        assertEq(reserve.maxRedeem(treasury), 0);
        vm.expectEmit(address(reserve));
        emit IKeelsonReserve.RedeemRequest(treasury, treasury, 0, treasury, shares);
        vm.prank(treasury);
        assertEq(reserve.requestRedeem(shares, treasury, treasury), 0);
        uint256 requestedAt = vm.getBlockTimestamp();
        assertEq(reserve.balanceOf(treasury), 0);
        assertEq(reserve.balanceOf(address(reserve)), shares);
        assertEq(reserve.pendingRedeemRequest(0, treasury), shares);
        assertEq(reserve.redeemReadyAt(treasury), requestedAt + reserve.cooldown());

        vm.warp(requestedAt + reserve.cooldown() - 1);
        vm.expectRevert(IKeelsonReserve.RedeemNotReady.selector);
        reserve.fulfillRedeem(treasury);
        vm.warp(requestedAt + reserve.cooldown());
        uint256 expected = reserve.convertToAssets(shares);
        vm.expectEmit(address(reserve));
        emit IKeelsonReserve.RedeemFulfilled(treasury, shares, expected);
        vm.prank(makeAddr("anyone"));
        assertEq(reserve.fulfillRedeem(treasury), expected);
        assertEq(reserve.pendingRedeemRequest(0, treasury), 0);
        assertEq(reserve.claimableRedeemRequest(0, treasury), shares);
        assertEq(reserve.maxRedeem(treasury), shares);
        assertEq(reserve.maxWithdraw(treasury), expected);
        assertEq(reserve.totalClaimableRedeem(), expected);
        assertEq(reserve.totalAssets(), 0, "set aside for the claim");
        vm.expectRevert(IKeelsonReserve.RedeemNotReady.selector);
        reserve.fulfillRedeem(treasury);

        vm.prank(treasury);
        reserve.redeem(shares / 2, treasury, treasury);
        assertApproxEqAbs(pyusd.balanceOf(treasury), expected / 2, 1);
        uint256 owed = reserve.maxWithdraw(treasury);
        vm.prank(treasury);
        reserve.withdraw(owed, treasury, treasury);
        assertEq(pyusd.balanceOf(treasury), expected);
        assertEq(reserve.maxRedeem(treasury), 0);
        assertEq(reserve.totalClaimableRedeem(), 0);
        _assertClaimsBacked();
    }

    /// @dev A new request restarts the controller's cooldown, so shares added late cannot ride an early request.
    function test_aNewRequestRestartsTheCooldown() public {
        vm.prank(treasury);
        reserve.requestRedeem(1e6, treasury, treasury);
        vm.warp(vm.getBlockTimestamp() + reserve.cooldown() - 1);
        uint256 rest = reserve.balanceOf(treasury);
        vm.prank(treasury);
        reserve.requestRedeem(rest, treasury, treasury);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectRevert(IKeelsonReserve.RedeemNotReady.selector);
        reserve.fulfillRedeem(treasury);
        vm.warp(reserve.redeemReadyAt(treasury));
        reserve.fulfillRedeem(treasury);
        assertEq(reserve.claimableRedeemRequest(0, treasury), SEED * 1e6);
    }

    /// @dev Requested shares still bear a warranty paid before their fulfilment.
    function test_aWarrantyDuringTheCooldownReducesThePayout() public {
        Vector memory v = _locked(WEBAUTHN);
        uint256 shares = reserve.balanceOf(treasury);
        vm.prank(treasury);
        reserve.requestRedeem(shares, treasury, treasury);
        uint256 before = reserve.convertToAssets(shares);
        _pay(_green(v, AMOUNT));
        vm.warp(reserve.redeemReadyAt(treasury));
        uint256 assets = reserve.fulfillRedeem(treasury);
        assertApproxEqAbs(assets, before - AMOUNT, 1);
    }

    /// @dev A fulfilled claim is fixed: a later warranty comes out of the stakers who stayed.
    function test_aFulfilledClaimIsFixed() public {
        Vector memory v = _locked(WEBAUTHN);
        address staker = makeAddr("staker who stays");
        _fundFromHolder(staker, 50e6);
        _stake(staker, 50e6);
        uint256 assets = _fulfil(treasury, reserve.balanceOf(treasury));
        _pay(_green(v, AMOUNT));
        assertEq(reserve.maxWithdraw(treasury), assets);
        uint256 claimable = reserve.maxRedeem(treasury);
        vm.prank(treasury);
        reserve.redeem(claimable, treasury, treasury);
        assertEq(pyusd.balanceOf(treasury), assets);
        assertLt(reserve.convertToAssets(reserve.balanceOf(staker)), 50e6);
        _assertClaimsBacked();
    }

    /// @dev An operator requests and claims for its controller; nobody else can, even with an allowance.
    function test_operatorsActForTheirControllerAndNobodyElse() public {
        address operator = makeAddr("operator");
        address stranger = makeAddr("stranger");
        uint256 shares = reserve.balanceOf(treasury);
        vm.prank(stranger);
        vm.expectRevert(IKeelsonReserve.NotOperator.selector);
        reserve.requestRedeem(1, treasury, treasury);

        vm.expectEmit(address(reserve));
        emit IKeelsonReserve.OperatorSet(treasury, operator, true);
        vm.prank(treasury);
        assertTrue(reserve.setOperator(operator, true));
        assertTrue(reserve.isOperator(treasury, operator));
        vm.prank(operator);
        reserve.requestRedeem(shares, treasury, treasury);
        vm.warp(reserve.redeemReadyAt(treasury));
        reserve.fulfillRedeem(treasury);

        vm.prank(treasury);
        assertTrue(reserve.approve(stranger, type(uint256).max));
        vm.startPrank(stranger);
        vm.expectRevert(IKeelsonReserve.NotOperator.selector);
        reserve.redeem(1, stranger, treasury);
        vm.expectRevert(IKeelsonReserve.NotOperator.selector);
        reserve.withdraw(1, stranger, treasury);
        vm.stopPrank();

        vm.prank(operator);
        reserve.redeem(shares, operator, treasury);
        assertEq(pyusd.balanceOf(operator), SEED);
    }

    /// @dev Spending an allowance, a third party may move an owner's shares into a request of a controller it operates.
    function test_requestSpendsTheOwnersAllowance() public {
        address controller = makeAddr("controller");
        vm.prank(treasury);
        assertTrue(reserve.approve(controller, 1e6));
        vm.prank(controller);
        reserve.requestRedeem(1e6, controller, treasury);
        assertEq(reserve.pendingRedeemRequest(0, controller), 1e6);
        assertEq(reserve.allowance(treasury, controller), 0);
        vm.prank(controller);
        vm.expectRevert();
        reserve.requestRedeem(1, controller, treasury);
    }

    function test_claimsBeyondWhatWasFulfilledRevert() public {
        _fulfil(treasury, 1e6);
        uint256 shares = reserve.maxRedeem(treasury);
        uint256 assets = reserve.maxWithdraw(treasury);
        vm.startPrank(treasury);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, treasury, shares + 1, shares));
        reserve.redeem(shares + 1, treasury, treasury);
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, treasury, assets + 1, assets)
        );
        reserve.withdraw(assets + 1, treasury, treasury);
        vm.expectRevert(IKeelsonReserve.ZeroAmount.selector);
        reserve.redeem(0, treasury, treasury);
        vm.expectRevert(IKeelsonReserve.ZeroAmount.selector);
        reserve.requestRedeem(0, treasury, treasury);
        vm.stopPrank();
    }

    /// @dev With no cooldown guard on transfers, `maxDeposit` and `maxMint` hold for every receiver.
    function test_depositsAndTransfersReachAnyReceiver() public {
        address other = makeAddr("requesting staker");
        _fundFromHolder(other, 2e6);
        _stake(other, 1e6);
        vm.prank(other);
        reserve.requestRedeem(1e6 * 1e6, other, other);
        assertEq(reserve.maxDeposit(other), type(uint256).max);
        _stake(other, 1e6);
        vm.prank(treasury);
        assertTrue(reserve.transfer(other, 1));
    }

    function test_setCooldownTakesTheTimelock() public {
        vm.expectRevert();
        reserve.setCooldown(1 days);
        _viaTimelock(address(reserve), abi.encodeCall(reserve.setCooldown, (1 days)));
        assertEq(reserve.cooldown(), 1 days);
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
