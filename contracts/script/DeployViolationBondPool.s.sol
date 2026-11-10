// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IPoolVault, ViolationBondPool} from "../src/ViolationBondPool.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";
import {IPYUSD} from "../src/interfaces/IPYUSD.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the `ViolationBondPool` over the registry's PYUSD, `KeelsonBondVault` and ERC-8004 Identity, paying
/// the convictions of the registry's `MandateViolationCourt`, governed by its AccessManager (setting courts is the
/// admin's, the timelock). Its withdrawal delay is twice the vault's, and a matured request can be completed within
/// the vault's delay.
contract DeployViolationBondPool is KeelsonDeploy {
    using stdJson for string;

    string internal constant POOL = "ViolationBondPool";

    function run() external returns (ViolationBondPool pool) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        pool = ViolationBondPool(_deploy(POOL, type(ViolationBondPool).creationCode, args()));
        vm.stopBroadcast();
    }

    function args() public view returns (bytes memory) {
        string memory json = _registry();
        address[] memory courts = new address[](1);
        courts[0] = json.readAddress(".contracts.MandateViolationCourt");
        return abi.encode(
            IPYUSD(json.readAddress(".external.pyusd")),
            IPoolVault(json.readAddress(".contracts.KeelsonBondVault")),
            IERC8004Identity(json.readAddress(".external.erc8004Identity")),
            json.readAddress(".contracts.AccessManager"),
            uint40(2 * json.readUint(".params.withdrawalDelay")),
            uint40(json.readUint(".params.withdrawalDelay")),
            courts
        );
    }
}
