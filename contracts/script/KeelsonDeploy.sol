// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonDeployer} from "../src/deploy/KeelsonDeployer.sol";
import {Create3} from "@openzeppelin/contracts/utils/Create3.sol";
import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// @notice Base of every Keelson deploy script: CREATE3 salts, offline address prediction, idempotent deployment and
/// the per-chain registry in `deployments/<chainId>.json`.
abstract contract KeelsonDeploy is Script {
    using stdJson for string;

    /// @notice Bumping the release redeploys the whole system at a new, again identical, set of addresses.
    string internal constant RELEASE = "keelson/v1";

    error DeployerOwnerMismatch(address expected, address actual);

    function salt(string memory name) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(RELEASE, "/", name));
    }

    /// @notice The `KeelsonDeployer` address, the same on every chain for the registry's owner.
    function deployerAddress() public view returns (address) {
        return vm.computeCreate2Address(bytes32(0), keccak256(_deployerInitCode()), CREATE2_FACTORY);
    }

    /// @notice The address `name` lands at on every chain, computed offline.
    function predict(string memory name) public view returns (address) {
        return Create3.computeAddress(salt(name), deployerAddress());
    }

    /// @dev The deployer EOA: owner of `KeelsonDeployer` and timelock proposer.
    function _owner() internal view returns (address) {
        return _registry().readAddress(".governance.proposer");
    }

    function _registryPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(vm.getChainId()), ".json");
    }

    function _registry() internal view returns (string memory json) {
        return vm.readFile(_registryPath());
    }

    function _deployerInitCode() internal view returns (bytes memory) {
        return abi.encodePacked(type(KeelsonDeployer).creationCode, abi.encode(_owner()));
    }

    /// @dev Calls the CREATE2 factory directly, which is what `new KeelsonDeployer{salt: 0}` does in a broadcast.
    function _ensureDeployer() internal returns (KeelsonDeployer deployer) {
        deployer = KeelsonDeployer(deployerAddress());
        if (address(deployer).code.length == 0) {
            (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(bytes32(0), _deployerInitCode()));
            require(ok && address(deployer).code.length > 0, "KeelsonDeployer not created");
        }
        if (deployer.owner() != _owner()) revert DeployerOwnerMismatch(_owner(), deployer.owner());
        _record("KeelsonDeployer", address(deployer), abi.encode(_owner()));
    }

    /// @dev Skips a salt whose address already has code, so a re-run deploys only what is missing.
    function _deploy(string memory name, bytes memory creationCode, bytes memory args)
        internal
        returns (address deployed)
    {
        deployed = predict(name);
        if (deployed.code.length == 0) {
            KeelsonDeployer(deployerAddress()).deploy(salt(name), abi.encodePacked(creationCode, args));
        }
        _record(name, deployed, args);
    }

    /// @dev As `_deploy`, at the address of `saltName` and recorded as `name`: a later version of a contract whose
    /// earlier one keeps its address.
    function _deployVersion(string memory name, string memory saltName, bytes memory creationCode, bytes memory args)
        internal
        returns (address deployed)
    {
        deployed = predict(saltName);
        if (deployed.code.length == 0) {
            KeelsonDeployer(deployerAddress()).deploy(salt(saltName), abi.encodePacked(creationCode, args));
        }
        _record(name, deployed, args);
    }

    /// @dev Writes back to the registry only when broadcasting, so tests and dry runs leave it untouched.
    function _record(string memory name, address deployed, bytes memory args) internal {
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) return;
        string memory path = _registryPath();
        vm.writeJson(string.concat('"', vm.toString(deployed), '"'), path, string.concat(".contracts.", name));
        vm.writeJson(string.concat('"', vm.toString(args), '"'), path, string.concat(".constructorArgs.", name));
    }
}
