// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ViolationBondPool} from "../../src/ViolationBondPool.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {IPyusd} from "../utils/IPyusd.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

/// @notice Drives the pool with deposits, withdrawal requests and completions by the operator, time, and payout
/// attempts for coverages the real court convicted and one it did not. Ghosts count what crossed the pool's boundary
/// and every payout that went through.
contract ViolationBondPoolHandler is CommonBase, StdUtils {
    ViolationBondPool internal immutable pool;
    IPyusd internal immutable pyusd;
    address internal immutable court;
    address internal immutable operator;
    uint256 internal immutable agentId;
    address internal immutable holder;
    KeelsonTypes.Coverage[] internal coverages;

    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public paidOut;
    mapping(bytes32 coverageId => uint256) public payouts;
    mapping(bytes32 coverageId => uint256) public paidFor;
    bytes32 public unconvicted;

    constructor(
        ViolationBondPool pool_,
        IPyusd pyusd_,
        address court_,
        address operator_,
        uint256 agentId_,
        address holder_,
        KeelsonTypes.Coverage[] memory coverages_,
        bytes32 unconvicted_
    ) {
        (pool, pyusd, court, operator, agentId, holder) = (pool_, pyusd_, court_, operator_, agentId_, holder_);
        for (uint256 i; i < coverages_.length; ++i) {
            coverages.push(coverages_[i]);
        }
        unconvicted = unconvicted_;
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 100e6);
        vm.prank(holder);
        pyusd.transfer(operator, amount);
        vm.startPrank(operator);
        pyusd.approve(address(pool), amount);
        pool.deposit(agentId, amount);
        vm.stopPrank();
        deposited += amount;
    }

    function requestWithdrawal(uint256 amount) external {
        uint128 balance = pool.deposits(agentId).balance;
        if (balance == 0) return;
        vm.prank(operator);
        pool.requestWithdrawal(agentId, uint128(bound(amount, 1, balance)), operator);
    }

    function completeWithdrawal() external {
        ViolationBondPool.Deposit memory d = pool.deposits(agentId);
        if (
            d.withdrawing == 0 || block.timestamp < d.unlockAt || block.timestamp > d.unlockAt + pool.completionWindow()
        ) {
            return;
        }
        uint256 before = pyusd.balanceOf(address(pool));
        pool.completeWithdrawal(agentId);
        withdrawn += before - pyusd.balanceOf(address(pool));
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 1 hours));
    }

    function pay(uint256 i) external {
        KeelsonTypes.Coverage memory c = coverages[bound(i, 0, coverages.length - 1)];
        uint256 before = pyusd.balanceOf(address(pool));
        try pool.payViolation(court, c) {
            payouts[c.coverageId] += 1;
            paidFor[c.coverageId] += before - pyusd.balanceOf(address(pool));
            paidOut += before - pyusd.balanceOf(address(pool));
        } catch {}
    }

    function coverageCount() external view returns (uint256) {
        return coverages.length;
    }

    function coverageAt(uint256 i) external view returns (KeelsonTypes.Coverage memory) {
        return coverages[i];
    }
}
