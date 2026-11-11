// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IDstackApp, IDstackKms} from "./interfaces/IDstack.sol";
import {Script} from "forge-std/Script.sol";

/// @notice Registers the TDX leg's app on dstack's on-chain KMS on Base with nothing allowed: no compose hash and no
/// device, so nothing boots under it until the owner allows a measured compose. The deployer owns it until `handOver`.
/// @dev `KMS_AUTH` is the `DstackKms` contract; `DSTACK_APP` the registered app, for `allow` and `handOver`.
contract BootstrapDstackApp is Script {
    function run() external returns (address appId) {
        IDstackKms kms = IDstackKms(vm.envAddress("KMS_AUTH"));
        vm.startBroadcast();
        appId = kms.deployAndRegisterApp(msg.sender, false, false, bytes32(0), bytes32(0));
        vm.stopBroadcast();
    }

    /// @notice While the deployer owns the app: allows one compose hash and one device.
    function allow(bytes32 composeHash, bytes32 deviceId) external {
        IDstackApp app = IDstackApp(vm.envAddress("DSTACK_APP"));
        vm.startBroadcast();
        app.addComposeHash(composeHash);
        app.addDevice(deviceId);
        vm.stopBroadcast();
    }

    /// @notice Stages `timelock` as the app's owner (`Ownable2Step`). The governance proposer then schedules the
    /// timelock's `acceptOwnership`; this prints its calldata.
    function handOver(address timelock) external returns (bytes memory accept) {
        IDstackApp app = IDstackApp(vm.envAddress("DSTACK_APP"));
        vm.startBroadcast();
        app.transferOwnership(timelock);
        vm.stopBroadcast();
        accept = abi.encodeCall(IDstackApp.acceptOwnership, ());
    }
}
