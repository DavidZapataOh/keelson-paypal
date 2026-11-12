// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ISafe} from "./interfaces/ISafe.sol";
import {ISafeProxyFactory} from "./interfaces/ISafeProxyFactory.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice The guardian Safe of a deployment registry: its owners and threshold, created by the Safe factory with
/// CREATE2, so equal owners and threshold give the same address on every chain.
library GuardianSafe {
    using stdJson for string;

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SALT_NONCE = uint256(keccak256("keelson.finance/guardian"));

    /// @notice Creates the Safe unless it exists, and returns it.
    function ensure(string memory json) internal returns (ISafe guardian) {
        guardian = ISafe(predict(json));
        if (address(guardian).code.length == 0) {
            require(
                ISafeProxyFactory(json.readAddress(".external.safeProxyFactory"))
                    .createProxyWithNonce(json.readAddress(".external.safeL2"), initializer(json), SALT_NONCE)
                == address(guardian),
                "Guardian Safe address"
            );
        }
    }

    function predict(string memory json) internal pure returns (address) {
        ISafeProxyFactory factory = ISafeProxyFactory(json.readAddress(".external.safeProxyFactory"));
        address singleton = json.readAddress(".external.safeL2");
        return VM.computeCreate2Address(
            keccak256(abi.encodePacked(keccak256(initializer(json)), SALT_NONCE)),
            keccak256(abi.encodePacked(factory.proxyCreationCode(), uint256(uint160(singleton)))),
            address(factory)
        );
    }

    function initializer(string memory json) internal pure returns (bytes memory) {
        return abi.encodeCall(
            ISafe.setup,
            (
                json.readAddressArray(".governance.guardianOwners"),
                json.readUint(".governance.guardianThreshold"),
                address(0),
                "",
                json.readAddress(".external.safeFallbackHandler"),
                address(0),
                0,
                payable(address(0))
            )
        );
    }
}
