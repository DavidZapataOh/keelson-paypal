// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployLogBond} from "../script/DeployLogBond.s.sol";
import {LogBond} from "../src/LogBond.sol";
import {ILogBond} from "../src/interfaces/ILogBond.sol";
import {ForkTest} from "./utils/Fork.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The deployed `Ed25519Verifier` and log bonds on Arbitrum Sepolia are this build, and the conformance bond was
/// slashed by the drill: the conformance tree and its fork at size 8 of `vectors/checkpoints.json`.
contract LogBondLiveTest is ForkTest {
    using stdJson for string;

    function _fresh(bytes memory init) internal returns (address fresh) {
        assembly ("memory-safe") {
            fresh := create(0, add(init, 0x20), mload(init))
        }
    }

    function test_DeployedBondsMatchTheBuild() public {
        string memory json = _jsonOf(421_614);
        vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
        DeployLogBond script = new DeployLogBond();
        address verifier = json.readAddress(".contracts.Ed25519Verifier");
        assertEq(verifier, script.predict("Ed25519Verifier"));
        assertEq(verifier.code, _fresh(script.verifierCode()).code);

        string[] memory names = vm.parseJsonKeys(json, ".contracts");
        for (uint256 i; i < names.length; ++i) {
            if (!vm.contains(names[i], "LogBond")) continue;
            LogBond bond = LogBond(json.readAddress(string.concat(".contracts.", names[i])));
            assertEq(address(bond), script.predict(names[i]));
            bytes memory args = json.readBytes(string.concat(".constructorArgs.", names[i]));
            assertEq(address(bond).code, _fresh(abi.encodePacked(type(LogBond).creationCode, args)).code);
            assertEq(address(bond.verifier()), verifier);
        }
    }

    function test_TheDrillSlashedTheConformanceBond() public {
        string memory json = _jsonOf(421_614);
        vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
        LogBond bond = LogBond(json.readAddress(".contracts.LogBondConformance"));
        string memory vectors = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/checkpoints.json"));
        ILogBond.Equivocation memory e = bond.equivocation();
        assertTrue(bond.slashed());
        assertEq(e.size, 8);
        assertEq(e.rootA, vectors.readBytes32(".cases[1].root"));
        assertEq(e.rootB, vectors.readBytes32(".cases[3].root"));
        assertGt(e.amount, 0);
        assertGt(e.l2Block, 0);
    }
}
