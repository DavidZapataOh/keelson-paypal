// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployViolationBondPool} from "../../script/DeployViolationBondPool.s.sol";
import {ViolationBondPool} from "../../src/ViolationBondPool.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {ViolationBase} from "../utils/ViolationBase.sol";
import {ViolationBondPoolHandler} from "./ViolationBondPoolHandler.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Whatever sequence of deposits, withdrawals, time and payout attempts: the pool holds exactly the deposit
/// and the failed payouts; it never pays a coverage twice, never pays one the court did not convict, and never pays
/// more than a coverage's amount.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
/// forge-config: default.invariant.runs = 32
/// forge-config: default.invariant.depth = 32
/// forge-config: ci.invariant.runs = 64
/// forge-config: ci.invariant.depth = 32
contract ViolationBondPoolInvariantTest is ViolationBase {
    using stdJson for string;

    ViolationBondPool internal pool;
    ViolationBondPoolHandler internal handler;

    function setUp() public override {
        super.setUp();
        pool = new DeployViolationBondPool().run();
        string[3] memory convicted = ["category", "merchant", "currency"];
        uint8[3] memory codes = [court.CATEGORY_NOT_ALLOWED(), court.MERCHANT_NOT_ALLOWED(), court.CURRENCY_MISMATCH()];
        KeelsonTypes.Coverage[] memory coverages = new KeelsonTypes.Coverage[](4);
        for (uint256 i; i < 3; ++i) {
            Case memory k = _lockedCase(convicted[i], codes[i]);
            court.proveViolation(k.coverage, k.countersign, k.hSd, k.countersigs, k.code, k.proof);
            coverages[i] = k.coverage;
        }
        Case memory clean = _lockedCase("expiry", court.MANDATE_EXPIRED());
        coverages[3] = clean.coverage;
        handler = new ViolationBondPoolHandler(
            pool,
            pyusd,
            address(court),
            operator,
            agentId,
            _json().readAddress(".external.pyusdHolder"),
            coverages,
            clean.coverage.coverageId
        );
        targetContract(address(handler));
    }

    function invariant_poolHoldsTheDepositAndTheFailedPayouts() public view {
        uint256 claimable;
        for (uint256 i; i < handler.coverageCount(); ++i) {
            claimable += pool.claimable(handler.coverageAt(i).merchant);
        }
        assertEq(pyusd.balanceOf(address(pool)), uint256(pool.deposits(agentId).balance) + claimable);
        assertEq(handler.deposited(), handler.withdrawn() + handler.paidOut() + pyusd.balanceOf(address(pool)));
    }

    function invariant_eachConvictedCoverageIsPaidAtMostOnce() public view {
        for (uint256 i; i < handler.coverageCount(); ++i) {
            bytes32 id = handler.coverageAt(i).coverageId;
            assertLe(handler.payouts(id), 1);
            assertEq(pool.paid(id), handler.payouts(id) == 1);
        }
    }

    function invariant_noConvictionNoPayout() public view {
        assertEq(handler.payouts(handler.unconvicted()), 0);
        assertFalse(pool.paid(handler.unconvicted()));
    }

    function invariant_noCoverageIsPaidMoreThanItsAmount() public view {
        uint256 cap;
        for (uint256 i; i < handler.coverageCount(); ++i) {
            if (pool.paid(handler.coverageAt(i).coverageId)) cap += handler.coverageAt(i).amount;
        }
        assertLe(handler.paidOut(), cap);
    }
}
