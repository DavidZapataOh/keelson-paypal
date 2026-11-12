// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IDstackApp, IDstackKms} from "./interfaces/IDstack.sol";
import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Registers the TDX leg's app on dstack's on-chain KMS on Base with nothing allowed: no compose hash and no
/// device, so nothing boots under it until the owner allows a measured compose. The deployer owns it until `handOver`.
/// @dev Reads the `DstackKms` and the registered app (`legA.appId`) from `deployments/8453.json`.
contract BootstrapDstackApp is Script {
    using stdJson for string;

    function registry() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/deployments/8453.json"));
    }

    function run() external returns (address appId) {
        IDstackKms kms = IDstackKms(registry().readAddress(".external.kmsAuth"));
        vm.startBroadcast();
        appId = kms.deployAndRegisterApp(msg.sender, false, false, bytes32(0), bytes32(0));
        vm.stopBroadcast();
    }

    /// @notice While the deployer owns the app: allows one compose hash and one device.
    function allow(bytes32 composeHash, bytes32 deviceId) external {
        IDstackApp app = IDstackApp(registry().readAddress(".legA.appId"));
        vm.startBroadcast();
        app.addComposeHash(composeHash);
        app.addDevice(deviceId);
        vm.stopBroadcast();
    }

    /// @notice Hands the app to the Base timelock. On a single-step `Ownable` app (the one Phala's KMS deploys on
    /// Base) that is final at once and `accept` is empty; on a two-step one the governance proposer must still
    /// schedule the timelock's `acceptOwnership`, whose calldata `accept` is.
    function handOver() external returns (bytes memory accept) {
        string memory json = registry();
        IDstackApp app = IDstackApp(json.readAddress(".legA.appId"));
        address timelock = json.readAddress(".governance.timelock");
        vm.startBroadcast();
        app.transferOwnership(timelock);
        vm.stopBroadcast();
        if (app.owner() != timelock) accept = abi.encodeCall(IDstackApp.acceptOwnership, ());
    }
}
