// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {LogBond} from "../src/LogBond.sol";
import {IEd25519Verifier} from "../src/interfaces/IEd25519Verifier.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the `Ed25519Verifier` (and the SCL library it links) and a `LogBond` on one log origin over the
/// registry's PYUSD: withdrawals wait seven days and lapse a day after, and a slash pays a 10% bounty to the prover and
/// the rest to the registry's `KeelsonReserve`, the warranty pool that pays for Keelson's own faults.
/// @dev `LOG_BOND_NAME` is the registry name (`LogBond` for the sandbox origin, `LogBondConformance` for the drill
/// origin), `LOG_BOND_ORIGIN` the origin string, `LOG_BOND_KEY` the hex Ed25519 key, `LOG_BOND_OWNER` the owner and
/// `LOG_BOND_NOTE` a checkpoint the log published, which the deployed bond must open.
contract DeployLogBond is KeelsonDeploy {
    using stdJson for string;

    string internal constant VERIFIER = "Ed25519Verifier";
    string internal constant SCL = "SCL_EIP6565";
    uint40 internal constant WITHDRAWAL_DELAY = 7 days;
    uint40 internal constant COMPLETION_WINDOW = 1 days;
    uint16 internal constant BOUNTY_BPS = 1000;

    function run() external returns (LogBond bond) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        _deploy(SCL, vm.getCode("libSCL_EIP6565.sol:SCL_EIP6565"), "");
        _deploy(VERIFIER, verifierCode(), "");
        bond = LogBond(_deploy(vm.envString("LOG_BOND_NAME"), type(LogBond).creationCode, args()));
        vm.stopBroadcast();
        (uint64 size,) = bond.checkpoint(vm.envBytes("LOG_BOND_NOTE"));
        require(size > 0, "the bond does not open the log's checkpoint");
    }

    function args() public view returns (bytes memory) {
        return abi.encode(
            IERC20(_registry().readAddress(".external.pyusd")),
            IEd25519Verifier(predict(VERIFIER)),
            vm.envAddress("LOG_BOND_OWNER"),
            keccak256(bytes(vm.envString("LOG_BOND_ORIGIN"))),
            vm.envBytes32("LOG_BOND_KEY"),
            WITHDRAWAL_DELAY,
            COMPLETION_WINDOW,
            _registry().readAddress(".contracts.KeelsonReserve"),
            BOUNTY_BPS
        );
    }

    /// @notice The verifier's creation code, linked to the SCL library at its CREATE3 address.
    /// @dev solc's placeholder is `__$`, the first 34 hex digits of keccak256 of the library's fully qualified name,
    /// and `$__`.
    function verifierCode() public view returns (bytes memory) {
        string memory artifact =
            vm.readFile(string.concat(vm.projectRoot(), "/out/Ed25519Verifier.sol/Ed25519Verifier.json"));
        bytes memory hash = bytes(vm.toString(keccak256("lib/crypto-lib/src/lib/libSCL_EIP6565.sol:SCL_EIP6565")));
        bytes memory digits = new bytes(34);
        for (uint256 i; i < 34; ++i) {
            digits[i] = hash[i + 2];
        }
        string memory addr = vm.replace(vm.toLowercase(vm.toString(predict(SCL))), "0x", "");
        return vm.parseBytes(
            vm.replace(artifact.readString(".bytecode.object"), string.concat("__$", string(digits), "$__"), addr)
        );
    }
}
