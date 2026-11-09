// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";

/// @notice Holds a measured path to its budget in `budgets.json` and records it in `snapshots/budgets.json`.
library GasBudget {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function check(string memory name, uint256 used) internal {
        uint256 budget = vm.parseJsonUint(vm.readFile("budgets.json"), string.concat(".", name));
        vm.snapshotValue("budgets", name, used);
        vm.assertLe(used, budget, name);
    }
}
