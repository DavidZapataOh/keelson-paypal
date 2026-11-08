// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonTypes} from "../libraries/KeelsonTypes.sol";
import {IERC8004Validation} from "./IERC8004Validation.sol";

/// @title IKeelsonValidationRegistry
/// @notice An ERC-8004 Validation registry with one validation per Alibi: the `VerdictVerifier` is the validator, the
/// request is the TEE-signed `Countersign` and the response its decision, then the coverage's outcome.
interface IKeelsonValidationRegistry is IERC8004Validation {
    /// @notice A validation for this countersign exists already.
    error ValidationExists();
    /// @notice The signatures are neither both legs' nor, for a degraded purchase, the TDX leg's alone.
    error InvalidCountersign();
    /// @notice An ALLOW countersign without a coverage the vault locked for the same agent.
    error NotCovered();
    error UnknownValidation();
    /// @notice The coverage is neither released clean nor slashed with no slash still pending.
    error OutcomeNotFinal();
    error OutcomeRecorded();
    /// @notice A DENY's `ValidationRequest` is signed by neither the agent's owner nor its agent wallet.
    error NotAgentAuthority();

    /// @notice Records the validation of an Alibi from its countersign and the legs' signatures (`tdx ‖ nitro`, or
    /// `tdx` alone when degraded). Permissionless. An ALLOW needs the coverage the vault locked under `c.requestId`
    /// for the same agent and amount; a DENY needs `operatorSig`, the agent owner's or agent wallet's EIP-712
    /// `ValidationRequest(bytes32 requestHash)` under this contract's domain `{Keelson, 1, chainId, this}`.
    /// @return requestHash The countersign's EIP-712 digest.
    function recordCountersign(KeelsonTypes.Countersign calldata c, bytes calldata sigs, bytes calldata operatorSig)
        external
        returns (bytes32 requestHash);

    /// @notice Moves a covered Alibi's validation to its coverage's outcome, read from the vault: `100`/`"settled"` for
    /// a clean release, `0`/`"slashed"` once a slash was paid and none is pending. Permissionless, once.
    function recordOutcome(bytes32 coverageId) external;

    /// @notice The validation of the ALLOW countersign whose request id is `coverageId`, or zero.
    function requestOf(bytes32 coverageId) external view returns (bytes32);

    function domainSeparator() external view returns (bytes32);
}
