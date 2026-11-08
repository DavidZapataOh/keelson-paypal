// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC8004Reputation} from "./interfaces/IERC8004Reputation.sol";
import {IKeelsonBondVault} from "./interfaces/IKeelsonBondVault.sol";
import {CoverageOutcome} from "./libraries/CoverageOutcome.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title KeelsonReputationReporter
/// @notice The `KeelsonBondVault`'s client on the official ERC-8004 Reputation registry: once per coverage, it rates
/// the operator `+1.00` (`"keelson"`/`"release"`) for a clean release and `-1.00` (`"keelson"`/`"slash"`) for a paid
/// slash, read from the vault's state. Permissionless, ownerless and not upgradeable; the vault's own `Slashed` events
/// and `slashCount` stay the authoritative record.
/// @dev The registry refuses feedback from the agent's owner or anyone it approved. An operator that approves this
/// contract, or transfers its agent to it, makes the call fail: the coverage then stays unrated, `FeedbackSkipped` is
/// emitted, and the rating can be retried. A refused `-1.00` blocks every `+1.00` of the agent until it lands. The registry is upgradeable by its authors, so it runs with a fixed gas
/// stipend that the caller must leave available, and its revert data is never copied.
contract KeelsonReputationReporter {
    using CoverageOutcome for IKeelsonBondVault;

    /// @notice Gas forwarded to `giveFeedback`: 1.5 times its worst case measured on v2.0.0 (the agent's first feedback
    /// from this client, every slot cold).
    uint256 public constant REPUTATION_GAS = 335_000;
    /// @dev Gas the call needs beyond the stipend: the arguments before it and the bookkeeping after.
    uint256 internal constant OVERHEAD = 40_000;
    uint8 public constant VALUE_DECIMALS = 2;
    string public constant TAG = "keelson";
    string public constant FEEDBACK_BASE_URI = "https://api.keelson.finance/v1/feedback/";

    IKeelsonBondVault public immutable vault;
    IERC8004Reputation public immutable reputation;

    mapping(bytes32 coverageId => bool) public rated;
    /// @notice Paid slashes of an agent whose `-1.00` the registry refused; while any is left, no `+1.00` is given.
    mapping(uint256 agentId => uint256) public unratedSlashes;
    mapping(bytes32 coverageId => bool) public slashSkipped;

    event CoverageRated(bytes32 indexed coverageId, uint256 indexed agentId, int128 value);
    /// @notice The registry refused or failed the feedback; the coverage can be rated again.
    event FeedbackSkipped(uint256 indexed agentId, bytes32 indexed coverageId);

    error AlreadyRated();
    /// @notice The coverage is neither released clean nor slashed with no slash still pending.
    error OutcomeNotFinal();
    /// @notice Too little gas left to give the registry its full stipend.
    error InsufficientGas();
    /// @notice A paid slash of the agent is still unrated: it must be rated before any clean release.
    error SlashUnrated();

    constructor(IKeelsonBondVault vault_, IERC8004Reputation reputation_) {
        vault = vault_;
        reputation = reputation_;
    }

    /// @notice Rates the operator of `coverageId` on its outcome. Returns whether the registry recorded the feedback.
    function rateCoverage(bytes32 coverageId) external returns (bool given) {
        if (rated[coverageId]) revert AlreadyRated();
        (CoverageOutcome.Outcome outcome, uint256 agentId) = vault.outcomeOf(coverageId);
        if (outcome == CoverageOutcome.Outcome.Open) revert OutcomeNotFinal();
        bool clean = outcome == CoverageOutcome.Outcome.Settled;
        // An owner that keeps the reporter approved, and revokes it only around its own clean releases, would collect
        // every +1.00 and dodge every -1.00.
        if (clean && unratedSlashes[agentId] != 0) revert SlashUnrated();
        int128 value = clean ? int128(100) : -100;
        string memory uri = feedbackURI(coverageId);
        // EIP-150 forwards at most 63/64 of what is left: without the floor a caller could starve the call into a skip.
        if (gasleft() < REPUTATION_GAS * 64 / 63 + OVERHEAD) revert InsufficientGas();
        rated[coverageId] = true;
        // forge-lint: disable-start(reentrancy-no-eth, reentrancy-events)
        try reputation.giveFeedback{gas: REPUTATION_GAS}(
            agentId, value, VALUE_DECIMALS, TAG, clean ? "release" : "slash", "", uri, bytes32(0)
        ) {
            if (slashSkipped[coverageId]) {
                slashSkipped[coverageId] = false;
                --unratedSlashes[agentId];
            }
            emit CoverageRated(coverageId, agentId, value);
            return true;
        } catch {
            rated[coverageId] = false;
            if (!clean && !slashSkipped[coverageId]) {
                slashSkipped[coverageId] = true;
                ++unratedSlashes[agentId];
            }
            emit FeedbackSkipped(agentId, coverageId);
        }
        // forge-lint: disable-end(reentrancy-no-eth, reentrancy-events)
    }

    /// @notice The ERC-8004 off-chain feedback file of a coverage, which the Keelson API builds from on-chain data.
    function feedbackURI(bytes32 coverageId) public pure returns (string memory) {
        return string.concat(FEEDBACK_BASE_URI, Strings.toHexString(uint256(coverageId), 32));
    }
}
