// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title IERC8004Validation
/// @notice The events and reads of the ERC-8004 Validation registry (v2.0.0), as its reference implementation declares
/// them.
interface IERC8004Validation {
    event ValidationRequest(
        address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash
    );

    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    function getIdentityRegistry() external view returns (address);

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        );

    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse);

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory);

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory);

    function getVersion() external pure returns (string memory);
}
