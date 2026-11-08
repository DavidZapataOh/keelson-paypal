// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @notice The parts of Paxos's PYUSD (PaxosTokenV2) the tests exercise.
interface IPyusd is IERC20Metadata {
    error AddressFrozen();
    error AuthorizationExpired();
    error AuthorizationInvalid();
    error CallerMustBePayee();
    error InvalidSignature();

    event AuthorizationAlreadyUsed(address indexed authorizer, bytes32 indexed nonce);

    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address owner) external view returns (uint256);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    function isFrozen(address addr) external view returns (bool);
    function hasRole(bytes32 role, address account) external view returns (bool);
    function freeze(address addr) external;

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes memory signature) external;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
