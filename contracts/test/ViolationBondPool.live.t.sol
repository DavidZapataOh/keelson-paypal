// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployViolationBondPool} from "../script/DeployViolationBondPool.s.sol";
import {ViolationBondPool} from "../src/ViolationBondPool.sol";
import {ForkTest} from "./utils/Fork.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The deployed `ViolationBondPool` on every chain whose registry lists it is this build, over the registry's
/// vault and Identity, paying the registry's `MandateViolationCourt`.
contract ViolationBondPoolLiveTest is ForkTest {
    using stdJson for string;

    function test_DeployedPoolMatchesTheBuild() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory json = _jsonOf(CHAIN_IDS[i]);
            if (!vm.keyExistsJson(json, ".contracts.ViolationBondPool")) continue;
            vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
            DeployViolationBondPool script = new DeployViolationBondPool();
            ViolationBondPool pool = ViolationBondPool(json.readAddress(".contracts.ViolationBondPool"));
            assertEq(address(pool), script.predict("ViolationBondPool"));
            bytes memory init = abi.encodePacked(type(ViolationBondPool).creationCode, script.args());
            address fresh;
            assembly ("memory-safe") {
                fresh := create(0, add(init, 0x20), mload(init))
            }
            assertEq(address(pool).code, fresh.code);
            assertEq(address(pool.vault()), json.readAddress(".contracts.KeelsonBondVault"));
            assertTrue(pool.isCourt(json.readAddress(".contracts.MandateViolationCourt")));
        }
    }
}
