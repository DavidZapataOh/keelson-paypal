// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title IERC8004Identity
/// @notice The parts of the ERC-8004 Identity registry (v2.0.0) Keelson reads: an agent is an ERC-721 token whose owner,
/// or the agent wallet the owner verified, speaks for it.
interface IERC8004Identity {
    function ownerOf(uint256 agentId) external view returns (address);

    /// @notice The wallet the owner proved control of, or zero; cleared when the agent is transferred.
    function getAgentWallet(uint256 agentId) external view returns (address);

    function register() external returns (uint256 agentId);

    function transferFrom(address from, address to, uint256 agentId) external;
}
