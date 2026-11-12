// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonBondVault} from "../../src/KeelsonBondVault.sol";
import {KeelsonReserve} from "../../src/KeelsonReserve.sol";
import {IKeelsonBondVault} from "../../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonHandler} from "./KeelsonHandler.sol";

/// @notice The vault's and the reserve's safety properties over a `KeelsonHandler`'s ghosts and the contracts' getters,
/// one per fuzzed property: `assert<Name>()` reverts with the reason when it fails (Foundry invariants), `check<Name>()`
/// returns whether it holds (Medusa properties).
abstract contract Properties {
    uint40 internal constant DEGRADED_DELAY = 72 hours;

    error PropertyViolated(string reason);

    function handler() internal view virtual returns (KeelsonHandler);

    // ---------------------------------------------------------------- I4

    /// @dev I4: every bond and every claim is backed by the vault's real PYUSD balance; the reserve's claims by its own.
    function checkConservation() internal view returns (bool, string memory) {
        KeelsonHandler h = handler();
        KeelsonBondVault vault = h.bondVault();
        KeelsonReserve reserve = h.warrantyReserve();
        uint256 owed;
        for (uint256 i; i < h.agentCount(); ++i) {
            IKeelsonBondVault.Bond memory b = vault.bonds(h.agents(i));
            owed += uint256(b.free) + b.locked + b.queued;
        }
        uint256 reserveClaims;
        for (uint256 i; i < h.trackedCount(); ++i) {
            owed += vault.claimable(h.tracked(i));
            reserveClaims += reserve.claimable(h.tracked(i));
        }
        if (owed > h.token().balanceOf(address(vault))) return (false, "I4: vault owes more than it holds");
        if (reserveClaims != reserve.totalClaimable()) return (false, "I4: reserve claims != totalClaimable");
        if (reserveClaims > h.token().balanceOf(address(reserve))) {
            return (false, "I4: reserve owes more than it holds");
        }
        return (true, "");
    }

    function assertConservation() internal view {
        (bool holds, string memory reason) = checkConservation();
        _require(holds, reason);
    }

    // ---------------------------------------------------------------- I2

    /// @dev I2: a dispute settles at most once across `slash`, `executeSlash` and `payWarranty`, in one contract only,
    /// and stays settled unless a veto reopened it, which happens at most once.
    function checkSettledUnique() internal view returns (bool, string memory) {
        KeelsonHandler h = handler();
        for (uint256 i; i < h.disputeCount(); ++i) {
            bytes32 id = h.disputeAt(i);
            bool inVault = h.bondVault().settled(id);
            bool inReserve = h.warrantyReserve().settled(id);
            uint256 n = h.ghostSettled(id);
            if (n > 1) return (false, "I2: dispute settled twice");
            if (inVault && inReserve) return (false, "I2: dispute settled by vault and reserve");
            if (n == 1 && !inVault && !inReserve) return (false, "I2: settlement undone");
            uint256 vetoes = h.ghostVetoes(id);
            if (vetoes > 1) return (false, "I2: dispute vetoed twice");
            if (h.bondVault().vetoed(id) != (vetoes == 1)) return (false, "I2: veto not recorded");
        }
        return (true, "");
    }

    function assertSettledUnique() internal view {
        (bool holds, string memory reason) = checkSettledUnique();
        _require(holds, reason);
    }

    // ---------------------------------------------------------------- I3

    /// @dev I3: slashes and warranties together never exceed the coverage.
    function checkSlashWithinCoverage() internal view returns (bool, string memory) {
        KeelsonHandler h = handler();
        for (uint256 i; i < h.vectorCount(); ++i) {
            bytes32 id = h.coverageIdAt(i);
            IKeelsonBondVault.CoverageState memory c = h.bondVault().coverages(id);
            if (c.status == IKeelsonBondVault.Status.None) continue;
            if (uint256(h.bondVault().slashed(id)) + h.warrantyReserve().warranted(id) > c.amount) {
                return (false, "I3: paid beyond coverage");
            }
        }
        return (true, "");
    }

    function assertSlashWithinCoverage() internal view {
        (bool holds, string memory reason) = checkSlashWithinCoverage();
        _require(holds, reason);
    }

    // ---------------------------------------------------------------- I1

    /// @dev I1: no forged signature set (lone Nitro, unregistered key, signatures over another verdict) ever settles.
    function checkNoUnsignedSlash() internal view returns (bool, string memory) {
        KeelsonHandler h = handler();
        if (h.ghostUnsignedSuccess() != 0) return (false, "I1: forged verdict accepted");
        for (uint256 i; i < h.invalidCount(); ++i) {
            bytes32 id = h.invalidAt(i);
            if (h.bondVault().settled(id) || h.warrantyReserve().settled(id)) {
                return (false, "I1: unsigned dispute settled");
            }
        }
        return (true, "");
    }

    function assertNoUnsignedSlash() internal view {
        (bool holds, string memory reason) = checkNoUnsignedSlash();
        _require(holds, reason);
    }

    // ---------------------------------------------------------------- I5

    /// @dev I5: no withdrawal completed before `readyAt` or while a slash was pending for its agent.
    function checkNoEarlyWithdrawal() internal view returns (bool, string memory) {
        if (handler().ghostEarlyCompletions() != 0) return (false, "I5: early withdrawal completed");
        return (true, "");
    }

    function assertNoEarlyWithdrawal() internal view {
        (bool holds, string memory reason) = checkNoEarlyWithdrawal();
        _require(holds, reason);
    }

    // ---------------------------------------------------------------- I6

    /// @dev I6: only the agent's authority can request, and completion pays exactly the `to` fixed at request.
    function checkWithdrawalRecipient() internal view returns (bool, string memory) {
        KeelsonHandler h = handler();
        if (h.ghostUnauthorizedRequests() != 0) return (false, "I6: withdrawal requested without authority");
        if (h.ghostMisdirectedWithdrawals() != 0) return (false, "I6: withdrawal paid elsewhere");
        return (true, "");
    }

    function assertWithdrawalRecipient() internal view {
        (bool holds, string memory reason) = checkWithdrawalRecipient();
        _require(holds, reason);
    }

    // ---------------------------------------------------------------- I7

    /// @dev I7: each slash, warranty and claim moved exactly its amount to the recipient, or into its `claimable`.
    function checkPayeeDelta() internal view returns (bool, string memory) {
        if (handler().ghostPayeeMismatch() != 0) return (false, "I7: payee credited a different amount");
        return (true, "");
    }

    function assertPayeeDelta() internal view {
        (bool holds, string memory reason) = checkPayeeDelta();
        _require(holds, reason);
    }

    // ---------------------------------------------------------------- I9

    /// @dev I9: every PYUSD that left the vault reached a tracked address entitled to it (a withdrawal's `to`, a verdict's
    /// recipient, a claimant's chosen `to`, the reserve for premiums), never more than it was entitled to.
    function checkOutflowsEntitled() internal view returns (bool, string memory) {
        KeelsonHandler h = handler();
        uint256 attributed;
        for (uint256 i; i < h.trackedCount(); ++i) {
            address a = h.tracked(i);
            if (h.ghostOut(a) > h.ghostEntitled(a)) return (false, "I9: outflow beyond entitlement");
            attributed += h.ghostOut(a);
        }
        if (attributed != h.ghostVaultOut()) return (false, "I9: outflow to an untracked address");
        return (true, "");
    }

    function assertOutflowsEntitled() internal view {
        (bool holds, string memory reason) = checkOutflowsEntitled();
        _require(holds, reason);
    }

    // ---------------------------------------------------------------- I12

    /// @dev I12: every `Slashed` (from the logs, where the fuzzer can record them) and every queued slash carries the
    /// digest of the verdict that was signed for its dispute.
    function checkSlashedDigest() internal view returns (bool, string memory) {
        KeelsonHandler h = handler();
        if (h.ghostDigestMismatch() != 0) return (false, "I12: Slashed digest differs from signed verdict");
        if (h.ghostUnknownSlashed() != 0) return (false, "I12: Slashed for an unsigned dispute");
        for (uint256 i; i < h.disputeCount(); ++i) {
            bytes32 id = h.disputeAt(i);
            IKeelsonBondVault.QueuedSlash memory q = h.bondVault().queuedSlashes(id);
            if (q.status != IKeelsonBondVault.SlashStatus.None && q.verdictDigest != h.dispute(id).digest) {
                return (false, "I12: queued digest differs from signed verdict");
            }
        }
        return (true, "");
    }

    function assertSlashedDigest() internal view {
        (bool holds, string memory reason) = checkSlashedDigest();
        _require(holds, reason);
    }

    // ---------------------------------------------------------------- LIA

    /// @dev LIA: the vault settles only verdicts naming the operator liable, the reserve only those naming Keelson.
    function checkLiable() internal view returns (bool, string memory) {
        KeelsonHandler h = handler();
        if (h.ghostWrongLiableSuccess() != 0) return (false, "LIA: wrong liable party paid");
        for (uint256 i; i < h.disputeCount(); ++i) {
            bytes32 id = h.disputeAt(i);
            uint8 liable = h.dispute(id).liable;
            if (h.bondVault().settled(id) && liable != 1) return (false, "LIA: vault paid a non-operator verdict");
            if (h.warrantyReserve().settled(id) && liable != 2) {
                return (false, "LIA: reserve paid a non-Keelson verdict");
            }
        }
        return (true, "");
    }

    function assertLiable() internal view {
        (bool holds, string memory reason) = checkLiable();
        _require(holds, reason);
    }

    // ---------------------------------------------------------------- DEG1

    /// @dev DEG1: a lone Nitro signature never locks coverage nor settles a dispute; a lone TDX signature never pays a
    /// warranty; a coverage is degraded exactly when its countersignature was the TDX leg's alone.
    function checkDegradedTdxOnly() internal view returns (bool, string memory) {
        KeelsonHandler h = handler();
        if (h.ghostNitroOnlySuccess() != 0) return (false, "DEG1: lone Nitro signature accepted");
        if (h.ghostWarrantyNot2of2() != 0) return (false, "DEG1: warranty paid without 2-of-2");
        for (uint256 i; i < h.vectorCount(); ++i) {
            IKeelsonBondVault.CoverageState memory c = h.bondVault().coverages(h.coverageIdAt(i));
            if (c.status != IKeelsonBondVault.Status.None && c.degraded != h.vectorDegraded(i)) {
                return (false, "DEG1: coverage degraded flag differs from its countersignature");
            }
        }
        return (true, "");
    }

    function assertDegradedTdxOnly() internal view {
        (bool holds, string memory reason) = checkDegradedTdxOnly();
        _require(holds, reason);
    }

    // ---------------------------------------------------------------- DEG2

    /// @dev DEG2: a slash on a degraded verdict or coverage is never paid at once: it is queued for at least 72 hours
    /// from settlement, and no queued slash executes before its `readyAt`.
    function checkDegradedQueued() internal view returns (bool, string memory) {
        KeelsonHandler h = handler();
        if (h.ghostEarlyExecutions() != 0) return (false, "DEG2: slash executed before readyAt");
        for (uint256 i; i < h.disputeCount(); ++i) {
            bytes32 id = h.disputeAt(i);
            KeelsonHandler.Dispute memory d = h.dispute(id);
            if (!d.degraded || d.warranty || !h.bondVault().settled(id)) continue;
            IKeelsonBondVault.QueuedSlash memory q = h.bondVault().queuedSlashes(id);
            if (q.status == IKeelsonBondVault.SlashStatus.None) return (false, "DEG2: degraded slash paid instantly");
            if (q.readyAt < uint256(d.settledAt) + DEGRADED_DELAY) return (false, "DEG2: degraded slash queued < 72h");
            if (d.executedAt != 0 && d.executedAt < q.readyAt) return (false, "DEG2: executed before readyAt");
        }
        return (true, "");
    }

    function assertDegradedQueued() internal view {
        (bool holds, string memory reason) = checkDegradedQueued();
        _require(holds, reason);
    }

    function _require(bool holds, string memory reason) private pure {
        if (!holds) revert PropertyViolated(reason);
    }
}
