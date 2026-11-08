// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../script/CoverageVector.sol";
import {KeelsonReputationReporter} from "../src/KeelsonReputationReporter.sol";
import {IERC8004Reputation} from "../src/interfaces/IERC8004Reputation.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {Erc8004Base} from "./utils/Erc8004Base.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The reporter rates real coverages on the official Reputation registry: +1.00 per clean release, -1.00 per
/// paid slash, nothing for a vetoed one, and an operator can neither block nor dodge its rating.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract ReputationReporterForkTest is Erc8004Base {
    using stdJson for string;

    uint96 internal constant AMOUNT = 50e6;

    function _summary(string memory tag2) internal view returns (uint64 count, int128 value, uint8 decimals) {
        return reputation.getSummary(agentId, _reporters(), "keelson", tag2);
    }

    function _assertFeedback(uint64 index, int128 value, string memory tag2) internal view {
        (int128 v, uint8 decimals, string memory tag1, string memory t2, bool revoked) =
            reputation.readFeedback(agentId, address(reporter), index);
        assertEq(v, value);
        assertEq(decimals, 2);
        assertEq(tag1, "keelson");
        assertEq(t2, tag2);
        assertFalse(revoked);
    }

    function test_rate_cleanRelease() public {
        Vector memory v = _locked(WEBAUTHN);
        bytes32 id = v.coverage.coverageId;
        vm.expectRevert(KeelsonReputationReporter.OutcomeNotFinal.selector);
        reporter.rateCoverage(id);

        _release(v);
        vm.expectEmit(address(reputation));
        emit IERC8004Reputation.NewFeedback(
            agentId,
            address(reporter),
            1,
            100,
            2,
            "keelson",
            "keelson",
            "release",
            "",
            string.concat("https://api.keelson.finance/v1/feedback/", vm.toString(id)),
            bytes32(0)
        );
        vm.expectEmit(address(reporter));
        emit KeelsonReputationReporter.CoverageRated(id, agentId, 100);
        assertTrue(reporter.rateCoverage(id));
        emit log_named_uint("rateCoverage first feedback", vm.lastCallGas().gasTotalUsed);

        assertTrue(reporter.rated(id));
        _assertFeedback(1, 100, "release");
        (uint64 count, int128 value, uint8 decimals) = _summary("");
        assertEq(count, 1);
        assertEq(value, 100);
        assertEq(decimals, 2);

        vm.expectRevert(KeelsonReputationReporter.AlreadyRated.selector);
        reporter.rateCoverage(id);
    }

    function test_rate_paidSlash() public {
        Vector memory v = _locked(WEBAUTHN);
        _slash(_amber(v, AMOUNT));
        assertTrue(reporter.rateCoverage(v.coverage.coverageId));
        _assertFeedback(1, -100, "slash");
        // A coverage rated for its slash is not rated again when it is released.
        _release(v);
        vm.expectRevert(KeelsonReputationReporter.AlreadyRated.selector);
        reporter.rateCoverage(v.coverage.coverageId);
    }

    /// @dev Two clean releases and one paid slash.
    function test_summary_mixedOutcomes() public {
        Vector memory payment = _locked(PAYMENT);
        Vector memory webauthn = _locked(WEBAUTHN);
        Vector memory degraded = _locked(DEGRADED);
        _slash(_amber(webauthn, AMOUNT));
        reporter.rateCoverage(webauthn.coverage.coverageId);
        _release(payment);
        reporter.rateCoverage(payment.coverage.coverageId);
        emit log_named_uint("rateCoverage later feedback", vm.lastCallGas().gasTotalUsed);
        _release(degraded);
        reporter.rateCoverage(degraded.coverage.coverageId);

        (uint64 count, int128 value, uint8 decimals) = _summary("");
        assertEq(count, 3);
        assertEq(value, 33);
        assertEq(decimals, 2);
        (count, value, decimals) = _summary("slash");
        assertEq(count, 1);
        assertEq(value, -100);
        assertEq(decimals, 2);
    }

    function _queue(Vector memory v) internal returns (KeelsonTypes.Verdict memory verdict) {
        IKeelsonBondVault.Params memory p = vault.params();
        p.instantSlashCap = 10e6;
        _viaTimelock(address(vault), abi.encodeCall(vault.setParams, (p)));
        verdict = _amber(v, AMOUNT);
        _slash(verdict);
        assertEq(vault.coverages(v.coverage.coverageId).pendingSlashes, 1);
    }

    function test_rate_vetoedSlashGivesNoSlashRating() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _queue(v);
        vm.expectRevert(KeelsonReputationReporter.OutcomeNotFinal.selector);
        reporter.rateCoverage(v.coverage.coverageId);

        vm.prank(_json().readAddress(".contracts.GuardianSafe"));
        vault.vetoSlash(verdict.disputeId, "wrong merchant");
        vm.expectRevert(KeelsonReputationReporter.OutcomeNotFinal.selector);
        reporter.rateCoverage(v.coverage.coverageId);

        _release(v);
        reporter.rateCoverage(v.coverage.coverageId);
        _assertFeedback(1, 100, "release");
        (uint64 count,,) = _summary("slash");
        assertEq(count, 0);
    }

    function test_rate_executedQueuedSlash() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _queue(v);
        vm.warp(vault.queuedSlashes(verdict.disputeId).readyAt);
        vm.expectRevert(KeelsonReputationReporter.OutcomeNotFinal.selector);
        reporter.rateCoverage(v.coverage.coverageId);
        vault.executeSlash(verdict.disputeId);
        reporter.rateCoverage(v.coverage.coverageId);
        _assertFeedback(1, -100, "slash");
    }

    /// @dev A paid slash on one coverage waits while another slash of the same agent is queued.
    function test_rate_waitsForTheAgentsQueuedSlashes() public {
        Vector memory payment = _locked(PAYMENT);
        Vector memory webauthn = _locked(WEBAUTHN);
        _slash(_verdict(payment, AMOUNT, OPERATOR, "PP-D-paid"));
        KeelsonTypes.Verdict memory queued = _queue(webauthn);
        vm.expectRevert(KeelsonReputationReporter.OutcomeNotFinal.selector);
        reporter.rateCoverage(payment.coverage.coverageId);
        vm.prank(_json().readAddress(".contracts.GuardianSafe"));
        vault.vetoSlash(queued.disputeId, "wrong merchant");
        reporter.rateCoverage(payment.coverage.coverageId);
        _assertFeedback(1, -100, "slash");
    }

    function test_rate_unknownCoverage() public {
        vm.expectRevert(KeelsonReputationReporter.OutcomeNotFinal.selector);
        reporter.rateCoverage(keccak256("no such coverage"));
    }

    function _assertSkippedThenRetried(bytes32 id) internal {
        vm.expectEmit(address(reporter));
        emit KeelsonReputationReporter.FeedbackSkipped(agentId, id);
        assertFalse(reporter.rateCoverage(id));
        assertFalse(reporter.rated(id));
        assertEq(reputation.getLastIndex(agentId, address(reporter)), 0);
    }

    function test_operatorApprovingTheReporter_skipsThenRetries() public {
        Vector memory v = _locked(WEBAUTHN);
        _slash(_amber(v, AMOUNT));
        assertEq(_bond().slashCount, 1);
        vm.prank(operator);
        _identity().setApprovalForAll(address(reporter), true);
        _assertSkippedThenRetried(v.coverage.coverageId);

        vm.prank(operator);
        _identity().setApprovalForAll(address(reporter), false);
        vm.prank(operator);
        _identity().approve(address(reporter), agentId);
        _assertSkippedThenRetried(v.coverage.coverageId);

        vm.prank(operator);
        _identity().approve(address(0), agentId);
        assertTrue(reporter.rateCoverage(v.coverage.coverageId));
        _assertFeedback(1, -100, "slash");
    }

    function test_operatorGivingTheAgentToTheReporter_skips() public {
        Vector memory v = _locked(WEBAUTHN);
        vm.prank(operator);
        _identity().transferFrom(operator, address(reporter), agentId);
        _release(v);
        _assertSkippedThenRetried(v.coverage.coverageId);
    }

    /// @dev No gas limit makes the call skip the feedback: either the floor reverts the whole call or the registry gets
    /// its full stipend.
    function test_gasStarvation_neverSkips() public {
        Vector memory v = _locked(WEBAUTHN);
        _release(v);
        bytes32 id = v.coverage.coverageId;
        uint256 floor = reporter.REPUTATION_GAS() * 64 / 63;
        uint256 reverted;
        for (uint256 gas = floor - 20_000; gas < floor + 120_000; gas += 1_000) {
            uint256 snapshot = vm.snapshotState();
            try reporter.rateCoverage{gas: gas}(id) returns (bool given) {
                assertTrue(given, "skipped by gas choice");
                assertEq(reputation.getLastIndex(agentId, address(reporter)), 1);
            } catch (bytes memory reason) {
                assertTrue(
                    reason.length == 0 || bytes4(reason) == KeelsonReputationReporter.InsufficientGas.selector,
                    "unexpected revert"
                );
                assertFalse(reporter.rated(id));
                ++reverted;
            }
            vm.revertToState(snapshot);
        }
        assertGt(reverted, 0, "floor reached");
        vm.expectRevert(KeelsonReputationReporter.InsufficientGas.selector);
        reporter.rateCoverage{gas: floor}(id);
    }

    /// @dev The worst case `REPUTATION_GAS` is sized from: the agent's first feedback from a new client, every slot
    /// cold, with the reporter's URI.
    function test_giveFeedback_worstCase() public {
        address client = makeAddr("erc8004 fresh client");
        string memory uri = reporter.feedbackURI(bytes32(type(uint256).max));
        vm.prank(client);
        uint256 start = gasleft();
        reputation.giveFeedback(agentId, -100, 2, "keelson", "release", "", uri, bytes32(0));
        uint256 used = start - gasleft();
        emit log_named_uint("giveFeedback worst case", used);
        assertGe(reporter.REPUTATION_GAS(), used * 3 / 2, "stipend below 1.5x worst case");
    }
}
