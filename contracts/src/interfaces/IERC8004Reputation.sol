// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title IERC8004Reputation
/// @notice The parts of the ERC-8004 Reputation registry (v2.0.0) Keelson writes and reads.
/// @dev `giveFeedback` reverts when the caller is the agent's owner or approved for it ("Self-feedback not allowed").
/// `getSummary` averages the matching feedback in the most frequent `valueDecimals` and requires a client list.
interface IERC8004Reputation {
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);

    function getVersion() external pure returns (string memory);
}
