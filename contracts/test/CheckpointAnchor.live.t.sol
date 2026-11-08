// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployCheckpointAnchor} from "../script/DeployCheckpointAnchor.s.sol";
import {CheckpointAnchor} from "../src/CheckpointAnchor.sol";
import {ForkTest} from "./utils/Fork.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The deployed CheckpointAnchor on every chain whose registry lists it is this build, over that chain's
/// VerdictVerifier.
contract CheckpointAnchorLiveTest is ForkTest {
    using stdJson for string;

    function test_DeployedAnchorMatchesItsScript() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory json = _jsonOf(CHAIN_IDS[i]);
            if (!vm.keyExistsJson(json, ".contracts.CheckpointAnchor")) continue;
            vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
            DeployCheckpointAnchor script = new DeployCheckpointAnchor();
            CheckpointAnchor anchor = CheckpointAnchor(json.readAddress(".contracts.CheckpointAnchor"));
            assertEq(address(anchor), script.predict("CheckpointAnchor"));
            assertEq(address(anchor.verifier()), json.readAddress(".contracts.VerdictVerifier"));
            // Built over the same verifier, this build's runtime code is the deployed one, immutable included.
            assertEq(address(anchor).code, address(new CheckpointAnchor(anchor.verifier())).code);
        }
    }
}
