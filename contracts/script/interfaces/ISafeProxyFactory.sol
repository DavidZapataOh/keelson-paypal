// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice The parts of Safe v1.5.0 `SafeProxyFactory` the deploy scripts use.
interface ISafeProxyFactory {
    function proxyCreationCode() external pure returns (bytes memory);
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}
