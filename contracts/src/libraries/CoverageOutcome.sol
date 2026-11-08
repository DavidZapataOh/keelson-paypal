// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IKeelsonBondVault} from "../interfaces/IKeelsonBondVault.sol";

/// @dev The vault's per-agent count of queued slashes, a public mapping outside `IKeelsonBondVault`.
interface IPendingSlashes {
    function pendingSlashes(uint256 agentId) external view returns (uint256);
}

/// @title CoverageOutcome
/// @notice How a coverage ended, read from the vault's state alone.
/// @dev `slashed(id)` counts queued slashes and drops a vetoed one, and a paid slash never leaves it. So a coverage with
/// `slashed(id) > 0` and no slash pending, for the coverage or its agent, has had a slash paid that nothing can undo;
/// the agent-wide check also covers a slash queued against a batch leaf sharing the coverage's id. A coverage released
/// with `slashed(id) == 0` was never slashed: a slash needs an active coverage. Batch leaves have no coverage state and
/// stay `Open`.
library CoverageOutcome {
    enum Outcome {
        Open,
        Settled,
        Slashed
    }

    function outcomeOf(IKeelsonBondVault vault, bytes32 coverageId)
        internal
        view
        returns (Outcome outcome, uint256 agentId)
    {
        IKeelsonBondVault.CoverageState memory cov = vault.coverages(coverageId);
        agentId = cov.agentId;
        if (cov.status == IKeelsonBondVault.Status.None) return (Outcome.Open, agentId);
        if (vault.slashed(coverageId) != 0) {
            if (cov.pendingSlashes == 0 && IPendingSlashes(address(vault)).pendingSlashes(agentId) == 0) {
                outcome = Outcome.Slashed;
            }
        } else if (cov.status == IKeelsonBondVault.Status.Released) {
            outcome = Outcome.Settled;
        }
    }
}
