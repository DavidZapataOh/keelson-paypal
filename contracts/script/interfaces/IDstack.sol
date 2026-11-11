// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice The boot facts dstack's on-chain KMS asks an app to allow (Dstack-TEE/dstack `IAppAuth`).
struct AppBootInfo {
    address appId;
    bytes32 composeHash;
    address instanceId;
    bytes32 deviceId;
    bytes32 mrAggregated;
    bytes32 mrSystem;
    bytes32 osImageHash;
    string tcbStatus;
    string[] advisoryIds;
}

/// @notice dstack's KMS authorization contract, which registers apps (Dstack-TEE/dstack `DstackKms`).
interface IDstackKms {
    event AppDeployedViaFactory(address appId, address deployer);

    function deployAndRegisterApp(
        address initialOwner,
        bool disableUpgrades,
        bool allowAnyDevice,
        bytes32 initialDeviceId,
        bytes32 initialComposeHash
    ) external returns (address appId);
}

/// @notice One app's boot policy: its allowed compose hashes and devices (Dstack-TEE/dstack `DstackApp`,
/// `Ownable2StepUpgradeable`).
interface IDstackApp {
    function addComposeHash(bytes32 composeHash) external;
    function removeComposeHash(bytes32 composeHash) external;
    function addDevice(bytes32 deviceId) external;
    function isAppAllowed(AppBootInfo calldata bootInfo) external view returns (bool isAllowed, string memory reason);
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
}
