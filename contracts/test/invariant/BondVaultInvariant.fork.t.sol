// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../../script/CoverageVector.sol";
import {IKeelsonBondVault} from "../../src/interfaces/IKeelsonBondVault.sol";
import {LockBase} from "../utils/VaultBase.sol";
import {BondVaultHandler} from "./BondVaultHandler.sol";

/// @notice Accounting: whatever sequence of deposits, locks, releases, requests, completions and time passes, every
/// PYUSD the vault received is in some agent's bond, was paid to the reserve as a premium, or was withdrawn; and the
/// bonds never exceed what the vault holds.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 64
/// forge-config: ci.invariant.runs = 256
/// forge-config: ci.invariant.depth = 64
contract BondVaultInvariantForkTest is LockBase {
    BondVaultHandler internal handler;
    uint256 internal startBalance;

    function setUp() public override {
        super.setUp();
        Vector[] memory vectors = new Vector[](3);
        vectors[0] = _vector(WEBAUTHN);
        vectors[1] = _vector(PAYMENT);
        vectors[2] = _vector(DEGRADED);
        uint256[] memory funderKeys = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            (, funderKeys[i]) = _funder(i);
        }
        handler = new BondVaultHandler(vault, pyusd, agentId, operatorKey, funderKeys, vectors);
        startBalance = pyusd.balanceOf(address(vault));
        // Enough bond for one live coverage (94.94 PYUSD); the funders keep the rest for random deposits.
        handler.deposit(0, 40e6, 0);
        handler.deposit(1, 30e6, 0);
        handler.deposit(2, 25e6, 0);
        targetContract(address(handler));
        // A fixed caller: every new sender of a forked test is an account fetched over RPC.
        targetSender(makeAddr("relayer"));
    }

    function _bonded() internal view returns (uint256 total) {
        for (uint256 i; i < handler.agentCount(); ++i) {
            IKeelsonBondVault.Bond memory b = vault.bonds(handler.agents(i));
            total += uint256(b.free) + b.locked + b.queued;
        }
    }

    function invariant_everyPyusdIsAccountedFor() public view {
        assertEq(_bonded() + handler.premiums(), handler.deposited() - handler.withdrawn());
    }

    function invariant_bondsAreBackedByTheBalance() public view {
        assertLe(_bonded(), pyusd.balanceOf(address(vault)) - startBalance);
    }
}
