// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title IConvictions
/// @notice A court that records, once per coverage, a proven violation by the coverage's operator. `code == 0` means
/// none; `provenAt` is when it was recorded.
interface IConvictions {
    function violations(bytes32 coverageId) external view returns (uint8 code, uint40 provenAt, bytes32 evidenceDigest);
}
