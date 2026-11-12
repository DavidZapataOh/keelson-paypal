// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../../script/CoverageVector.sol";
import {IKeelsonReserve} from "../../src/interfaces/IKeelsonReserve.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {SlashBase} from "../utils/SlashBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626Test, IERC4626} from "erc4626-tests/ERC4626.test.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice a16z's ERC-4626 property suite against `KeelsonReserve` on a fork of Arbitrum Sepolia, over real PYUSD.
/// @dev PYUSD cannot be minted or burned, so balances come from the pinned holder, a gain is PYUSD sent to the
/// reserve, and a loss is a real warranty paid on a coverage locked from a live vector. Deposits are synchronous and
/// run the suite as written. Redemptions are ERC-7540 requests: every redeem or withdraw first requests the shares,
/// waits the cooldown and fulfils them, inside the suite's no-free-profit check; previews revert, and a claim is the
/// controller's (or its operator's), not an allowance holder's.
/// forge-config: default.evm_version = "osaka"
/// forge-config: default.fuzz.runs = 16
/// forge-config: ci.evm_version = "osaka"
/// forge-config: ci.fuzz.runs = 128
contract Reserve4626Test is ERC4626Test, SlashBase {
    using stdJson for string;

    /// @dev Per user and per leg, so four users and a gain stay within the holder's balance at the fork block.
    uint256 internal constant CAP = 1e11;

    Vector internal covered;
    address internal holder;
    uint256 internal disputes;

    function setUp() public override(ERC4626Test, SlashBase) {
        SlashBase.setUp();
        covered = _locked(WEBAUTHN);
        holder = _json().readAddress(".external.pyusdHolder");
        _underlying_ = address(pyusd);
        _vault_ = address(reserve);
        _delta_ = 0;
        _vaultMayBeEmpty = true;
        _unlimitedAmount = false;
    }

    function setUpVault(Init memory init) public override {
        for (uint256 i; i < N; ++i) {
            address user = init.user[i];
            vm.assume(_isEOA(user) && _usable(user));
            uint256 shares = bound(init.share[i], 0, CAP);
            _give(user, shares);
            _approve(_underlying_, user, _vault_, shares);
            vm.prank(user);
            try IERC4626(_vault_).deposit(shares, user) {}
            catch {
                vm.assume(false);
            }
            _give(user, bound(init.asset[i], 0, CAP));
        }
        setUpYield(init);
    }

    function setUpYield(Init memory init) public override {
        if (init.yield >= 0) {
            _give(_vault_, bound(uint256(init.yield), 0, CAP));
            return;
        }
        uint256 loss = init.yield == type(int256).min ? type(uint256).max : uint256(-init.yield);
        uint256 room = covered.coverage.amount - reserve.warranted(covered.coverage.coverageId);
        if (reserve.totalAssets() < room) room = reserve.totalAssets();
        if (reserve.rateLimitAvailable() < room) room = reserve.rateLimitAvailable();
        loss = bound(loss, 0, room);
        if (loss == 0) return;
        KeelsonTypes.Verdict memory v =
            _verdict(covered, uint96(loss), KEELSON, string.concat("PP-D-4626-", vm.toString(++disputes)));
        reserve.payWarranty(v, treeSize, _sign2of2(v));
    }

    // ---------------------------------------------------------------- asynchronous redemption

    function test_previewWithdraw(Init memory init, uint256 assets) public override {
        setUpVault(init);
        vm.expectRevert(IKeelsonReserve.AsyncRedeem.selector);
        reserve.previewWithdraw(assets);
    }

    function test_previewRedeem(Init memory init, uint256 shares) public override {
        setUpVault(init);
        vm.expectRevert(IKeelsonReserve.AsyncRedeem.selector);
        reserve.previewRedeem(shares);
    }

    /// @dev withdraw(a) pays exactly `a` to the receiver from the owner's fulfilled request and burns no more shares
    /// than it holds there.
    function test_withdraw(Init memory init, uint256 assets, uint256) public override {
        setUpVault(init);
        address receiver = init.user[1];
        address owner = init.user[2];
        _fulfil(owner, reserve.balanceOf(owner));
        vm.assume(reserve.maxWithdraw(owner) > 0);
        assets = bound(assets, 1, reserve.maxWithdraw(owner));
        uint256 claimable = reserve.claimableRedeemRequest(0, owner);
        uint256 before = pyusd.balanceOf(receiver);
        vm.prank(owner);
        uint256 shares = reserve.withdraw(assets, receiver, owner);
        assertEq(pyusd.balanceOf(receiver) - before, assets);
        assertEq(claimable - reserve.claimableRedeemRequest(0, owner), shares);
    }

    /// @dev redeem(s) pays the receiver what fulfilment fixed for those shares, pro rata.
    function test_redeem(Init memory init, uint256 shares, uint256) public override {
        setUpVault(init);
        address receiver = init.user[1];
        address owner = init.user[2];
        _fulfil(owner, reserve.balanceOf(owner));
        uint256 claimable = reserve.maxRedeem(owner);
        vm.assume(claimable > 0);
        shares = bound(shares, 1, claimable);
        uint256 owed = reserve.maxWithdraw(owner);
        uint256 before = pyusd.balanceOf(receiver);
        vm.prank(owner);
        uint256 assets = reserve.redeem(shares, receiver, owner);
        assertEq(pyusd.balanceOf(receiver) - before, assets);
        assertEq(assets, shares == claimable ? owed : owed * shares / claimable);
    }

    // ---------------------------------------------------------------- round trips across the cooldown

    function test_RT_deposit_redeem(Init memory init, uint256 assets) public override {
        setUpVault(init);
        address caller = init.user[0];
        assets = bound(assets, 0, _max_deposit(caller));
        _approve(_underlying_, caller, _vault_, type(uint256).max);
        _rtDepositRedeem(caller, assets);
    }

    function test_RT_deposit_withdraw(Init memory init, uint256 assets) public override {
        setUpVault(init);
        address caller = init.user[0];
        assets = bound(assets, 0, _max_deposit(caller));
        _approve(_underlying_, caller, _vault_, type(uint256).max);
        _rtDepositWithdraw(caller, assets);
    }

    function test_RT_mint_withdraw(Init memory init, uint256 shares) public override {
        setUpVault(init);
        address caller = init.user[0];
        shares = bound(shares, 0, _max_mint(caller));
        _approve(_underlying_, caller, _vault_, type(uint256).max);
        _rtMintWithdraw(caller, shares);
    }

    function test_RT_mint_redeem(Init memory init, uint256 shares) public override {
        setUpVault(init);
        address caller = init.user[0];
        shares = bound(shares, 0, _max_mint(caller));
        _approve(_underlying_, caller, _vault_, type(uint256).max);
        _rtMintRedeem(caller, shares);
    }

    function test_RT_redeem_deposit(Init memory init, uint256 shares) public override {
        setUpVault(init);
        address caller = init.user[2];
        shares = bound(shares, 0, _max_redeem(caller));
        _approve(_underlying_, caller, _vault_, type(uint256).max);
        _rtRedeemDeposit(caller, shares);
    }

    function test_RT_redeem_mint(Init memory init, uint256 shares) public override {
        setUpVault(init);
        address caller = init.user[2];
        shares = bound(shares, 0, _max_redeem(caller));
        _approve(_underlying_, caller, _vault_, type(uint256).max);
        _rtRedeemMint(caller, shares);
    }

    function test_RT_withdraw_mint(Init memory init, uint256 assets) public override {
        setUpVault(init);
        address caller = init.user[2];
        assets = bound(assets, 0, _max_withdraw(caller));
        _approve(_underlying_, caller, _vault_, type(uint256).max);
        _rtWithdrawMint(caller, assets);
    }

    function test_RT_withdraw_deposit(Init memory init, uint256 assets) public override {
        setUpVault(init);
        address caller = init.user[2];
        assets = bound(assets, 0, _max_withdraw(caller));
        _approve(_underlying_, caller, _vault_, type(uint256).max);
        _rtWithdrawDeposit(caller, assets);
    }

    /// @dev redeem(deposit(a)) <= a
    function _rtDepositRedeem(address caller, uint256 assets) internal checkNoFreeProfit(caller) {
        vm.prank(caller);
        uint256 shares = vault_deposit(assets, caller);
        _fulfil(caller, shares);
        vm.prank(caller);
        uint256 assets2 = vault_redeem(shares, caller, caller);
        assertApproxLeAbs(assets2, assets, _delta_);
    }

    /// @dev withdraw(a) burns at least the shares deposit(a) minted.
    function _rtDepositWithdraw(address caller, uint256 assets) internal checkNoFreeProfit(caller) {
        vm.prank(caller);
        uint256 shares1 = vault_deposit(assets, caller);
        _fulfil(caller, shares1);
        uint256 owed = reserve.maxWithdraw(caller);
        assertApproxLeAbs(owed, assets, _delta_);
        vm.prank(caller);
        uint256 shares2 = vault_withdraw(owed, caller, caller);
        assertApproxGeAbs(shares2, shares1, _delta_);
    }

    /// @dev withdraw(mint(s)) >= s
    function _rtMintWithdraw(address caller, uint256 shares) internal checkNoFreeProfit(caller) {
        vm.prank(caller);
        uint256 assets = vault_mint(shares, caller);
        _fulfil(caller, shares);
        uint256 owed = reserve.maxWithdraw(caller);
        assertApproxLeAbs(owed, assets, _delta_);
        vm.prank(caller);
        uint256 shares2 = vault_withdraw(owed, caller, caller);
        assertApproxGeAbs(shares2, shares, _delta_);
    }

    /// @dev redeem(s) returns at most what mint(s) cost.
    function _rtMintRedeem(address caller, uint256 shares) internal checkNoFreeProfit(caller) {
        vm.prank(caller);
        uint256 assets1 = vault_mint(shares, caller);
        _fulfil(caller, shares);
        vm.prank(caller);
        uint256 assets2 = vault_redeem(shares, caller, caller);
        assertApproxLeAbs(assets2, assets1, _delta_);
    }

    /// @dev deposit(redeem(s)) <= s
    function _rtRedeemDeposit(address caller, uint256 shares) internal checkNoFreeProfit(caller) {
        _fulfil(caller, shares);
        vm.prank(caller);
        uint256 assets = vault_redeem(shares, caller, caller);
        vm.prank(caller);
        uint256 shares2 = vault_deposit(assets, caller);
        assertApproxLeAbs(shares2, shares, _delta_);
    }

    /// @dev mint(s) costs at least what redeem(s) returned.
    function _rtRedeemMint(address caller, uint256 shares) internal checkNoFreeProfit(caller) {
        _fulfil(caller, shares);
        vm.prank(caller);
        uint256 assets1 = vault_redeem(shares, caller, caller);
        vm.prank(caller);
        uint256 assets2 = vault_mint(shares, caller);
        assertApproxGeAbs(assets2, assets1, _delta_);
    }

    /// @dev mint(withdraw(a)) >= a
    function _rtWithdrawMint(address caller, uint256 assets) internal checkNoFreeProfit(caller) {
        _fulfil(caller, reserve.balanceOf(caller));
        vm.prank(caller);
        uint256 shares = vault_withdraw(assets, caller, caller);
        vm.prank(caller);
        uint256 assets2 = vault_mint(shares, caller);
        assertApproxGeAbs(assets2, assets, _delta_);
    }

    /// @dev deposit(a) mints at most the shares withdraw(a) burned.
    function _rtWithdrawDeposit(address caller, uint256 assets) internal checkNoFreeProfit(caller) {
        _fulfil(caller, reserve.balanceOf(caller));
        vm.prank(caller);
        uint256 shares1 = vault_withdraw(assets, caller, caller);
        vm.prank(caller);
        uint256 shares2 = vault_deposit(assets, caller);
        assertApproxLeAbs(shares2, shares1, _delta_);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Requests `shares` of `owner` for itself, waits the cooldown and fulfils them; nothing when `shares` is 0.
    function _fulfil(address owner, uint256 shares) internal {
        if (shares == 0) return;
        vm.prank(owner);
        reserve.requestRedeem(shares, owner, owner);
        vm.warp(reserve.redeemReadyAt(owner));
        reserve.fulfillRedeem(owner);
    }

    /// @dev Real PYUSD from the pinned holder.
    function _give(address to, uint256 amount) internal {
        if (amount == 0) return;
        vm.prank(holder);
        assertTrue(IERC20(_underlying_).transfer(to, amount));
    }

    /// @dev An account PYUSD can pay and that holds nothing the suite does not account for.
    function _usable(address user) internal view returns (bool) {
        return user != address(0) && user != holder && user != _vault_ && user != address(vault)
            && !pyusd.isFrozen(user) && pyusd.balanceOf(user) == 0 && reserve.balanceOf(user) == 0
            && reserve.pendingRedeemRequest(0, user) == 0 && reserve.claimableRedeemRequest(0, user) == 0;
    }
}
