// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IPYUSD
/// @notice PayPal USD (Paxos `PaxosTokenV2`): ERC-20 with EIP-3009 and ERC-2612 in their `bytes signature` forms, which
/// also accept ERC-1271 signatures.
interface IPYUSD is IERC20 {
    /// @notice EIP-3009: `to` must be the caller. A nonce already used is ignored, not reverted.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature) external;
}
