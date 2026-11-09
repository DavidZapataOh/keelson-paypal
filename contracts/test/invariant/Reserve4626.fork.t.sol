// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../../script/CoverageVector.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {SlashBase} from "../utils/SlashBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626Test, IERC4626} from "erc4626-tests/ERC4626.test.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice a16z's ERC-4626 property suite against `KeelsonReserve` on a fork of Arbitrum Sepolia, over real PYUSD.
/// @dev PYUSD cannot be minted or burned, so balances come from the pinned holder, a gain is PYUSD sent to the
/// reserve, and a loss is a real warranty paid on a coverage locked from a live vector. Shares leave only inside the
/// owner's cooldown window, and nothing can be minted to an owner whose cooldown runs, so: the owner in the withdraw
/// and redeem tests (`user[2]`) is inside its window, and each round trip waits the cooldown between its legs (deposit
/// or mint, then the window opens, then redeem or withdraw; redeem or withdraw inside the window, then it closes, then
/// deposit or mint) with the suite's own no-free-profit check across both.
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
        vm.prank(init.user[2]);
        reserve.requestCooldown();
        vm.warp(vm.getBlockTimestamp() + reserve.cooldown());
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
        _openWindow(caller);
        vm.prank(caller);
        uint256 assets2 = vault_redeem(shares, caller, caller);
        assertApproxLeAbs(assets2, assets, _delta_);
    }

    /// @dev withdraw(a) burns at least the shares deposit(a) minted.
    function _rtDepositWithdraw(address caller, uint256 assets) internal checkNoFreeProfit(caller) {
        vm.prank(caller);
        uint256 shares1 = vault_deposit(assets, caller);
        _openWindow(caller);
        vm.prank(caller);
        uint256 shares2 = vault_withdraw(assets, caller, caller);
        assertApproxGeAbs(shares2, shares1, _delta_);
    }

    /// @dev withdraw(mint(s)) >= s
    function _rtMintWithdraw(address caller, uint256 shares) internal checkNoFreeProfit(caller) {
        vm.prank(caller);
        uint256 assets = vault_mint(shares, caller);
        _openWindow(caller);
        vm.prank(caller);
        uint256 shares2 = vault_withdraw(assets, caller, caller);
        assertApproxGeAbs(shares2, shares, _delta_);
    }

    /// @dev redeem(s) returns at most what mint(s) cost.
    function _rtMintRedeem(address caller, uint256 shares) internal checkNoFreeProfit(caller) {
        vm.prank(caller);
        uint256 assets1 = vault_mint(shares, caller);
        _openWindow(caller);
        vm.prank(caller);
        uint256 assets2 = vault_redeem(shares, caller, caller);
        assertApproxLeAbs(assets2, assets1, _delta_);
    }

    /// @dev deposit(redeem(s)) <= s
    function _rtRedeemDeposit(address caller, uint256 shares) internal checkNoFreeProfit(caller) {
        vm.prank(caller);
        uint256 assets = vault_redeem(shares, caller, caller);
        _closeWindow(caller);
        vm.prank(caller);
        uint256 shares2 = vault_deposit(assets, caller);
        assertApproxLeAbs(shares2, shares, _delta_);
    }

    /// @dev mint(s) costs at least what redeem(s) returned.
    function _rtRedeemMint(address caller, uint256 shares) internal checkNoFreeProfit(caller) {
        vm.prank(caller);
        uint256 assets1 = vault_redeem(shares, caller, caller);
        _closeWindow(caller);
        vm.prank(caller);
        uint256 assets2 = vault_mint(shares, caller);
        assertApproxGeAbs(assets2, assets1, _delta_);
    }

    /// @dev mint(withdraw(a)) >= a
    function _rtWithdrawMint(address caller, uint256 assets) internal checkNoFreeProfit(caller) {
        vm.prank(caller);
        uint256 shares = vault_withdraw(assets, caller, caller);
        _closeWindow(caller);
        vm.prank(caller);
        uint256 assets2 = vault_mint(shares, caller);
        assertApproxGeAbs(assets2, assets, _delta_);
    }

    /// @dev deposit(a) mints at most the shares withdraw(a) burned.
    function _rtWithdrawDeposit(address caller, uint256 assets) internal checkNoFreeProfit(caller) {
        vm.prank(caller);
        uint256 shares1 = vault_withdraw(assets, caller, caller);
        _closeWindow(caller);
        vm.prank(caller);
        uint256 shares2 = vault_deposit(assets, caller);
        assertApproxLeAbs(shares2, shares1, _delta_);
    }

    // ---------------------------------------------------------------- helpers

    function _openWindow(address owner) internal {
        vm.prank(owner);
        reserve.requestCooldown();
        vm.warp(vm.getBlockTimestamp() + reserve.cooldown());
    }

    function _closeWindow(address owner) internal {
        vm.warp(uint256(reserve.cooldownStart(owner)) + reserve.cooldown() + reserve.unstakeWindow() + 1);
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
            && reserve.cooldownStart(user) == 0;
    }
}
