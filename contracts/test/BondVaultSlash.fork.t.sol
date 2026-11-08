// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../script/CoverageVector.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {SlashBase} from "./utils/SlashBase.sol";

/// @notice Instant slashes against coverages locked from the live vectors, on a fork of Arbitrum Sepolia with real
/// PYUSD and the real `CheckpointAnchor`; payouts that fail become claims.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract BondVaultSlashForkTest is SlashBase {
    uint96 internal constant AMOUNT = 50e6;

    function test_slash_instantPaysMerchant() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _amber(v, AMOUNT);
        bytes memory sigs = _sign2of2(verdict);
        uint128 lockedBefore = _bond().locked;

        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.Slashed(
            verdict.disputeId,
            verdict.coverageId,
            agentId,
            merchant,
            AMOUNT,
            VARIANT_FIELD,
            verdict.evidenceHash,
            _digest(verdict)
        );
        vm.prank(makeAddr("relayer"));
        vault.slash(verdict, treeSize, sigs);
        uint256 gas = _executionGas(abi.encodeCall(vault.slash, (verdict, treeSize, sigs)));
        emit log_named_uint("slash instant execution", gas);

        assertEq(pyusd.balanceOf(merchant), AMOUNT);
        assertEq(_bond().locked, lockedBefore - AMOUNT);
        assertEq(_bond().slashCount, 1);
        assertTrue(vault.settled(verdict.disputeId));
        assertEq(vault.slashed(v.coverage.coverageId), AMOUNT);
        assertEq(vault.rateLimitAvailable(), 1_000e6 - AMOUNT);
        _assertBacked();
    }

    function test_slash_paysPayoutAddress() public {
        address payout = makeAddr("merchant payout");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", vault.domainSeparator(), KeelsonTypes.hashPayoutAddress(merchant, payout, 0, deadline)
            )
        );
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(merchantKey, digest);
        vault.setPayoutAddress(merchant, payout, 0, deadline, abi.encodePacked(r, s, sv));

        Vector memory v = _locked(WEBAUTHN);
        _slash(_amber(v, AMOUNT));
        assertEq(pyusd.balanceOf(payout), AMOUNT);
        assertEq(pyusd.balanceOf(merchant), 0);
    }

    function test_slash_revertsUnlessOperatorLiable() public {
        Vector memory v = _locked(WEBAUTHN);
        for (uint8 liable = 2; liable <= 4; ++liable) {
            KeelsonTypes.Verdict memory verdict = _verdict(v, AMOUNT, liable, "PP-D-other");
            bytes memory sigs = _sign2of2(verdict);
            vm.expectRevert(IKeelsonBondVault.NotOperatorLiable.selector);
            vault.slash(verdict, treeSize, sigs);
        }
    }

    function test_slash_revertsOnReuse() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _amber(v, 10e6);
        _slash(verdict);
        bytes memory sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonBondVault.AlreadySettled.selector);
        vault.slash(verdict, treeSize, sigs);
    }

    function test_slash_revertsAfterDeadline() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _amber(v, AMOUNT);
        bytes memory sigs = _sign2of2(verdict);
        vm.warp(uint256(verdict.deadline) + 1);
        vm.expectRevert(IKeelsonBondVault.Expired.selector);
        vault.slash(verdict, treeSize, sigs);
    }

    function test_slash_revertsUnanchoredRoot() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _amber(v, AMOUNT);
        verdict.checkpointRoot = keccak256("a root never anchored");
        bytes memory sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonBondVault.NotAnchored.selector);
        vault.slash(verdict, treeSize, sigs);

        verdict = _amber(v, AMOUNT);
        sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonBondVault.NotAnchored.selector);
        vault.slash(verdict, treeSize + 1, sigs);
    }

    function test_slash_revertsAfterRelease() public {
        Vector memory v = _locked(WEBAUTHN);
        vm.warp(uint256(vault.coverages(v.coverage.coverageId).releaseAfter) + 1);
        vault.releaseCoverage(v.coverage.coverageId);
        KeelsonTypes.Verdict memory verdict = _amber(v, AMOUNT);
        bytes memory sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonBondVault.CoverageNotActive.selector);
        vault.slash(verdict, treeSize, sigs);
    }

    function test_slash_atReleaseAfterBoundary() public {
        Vector memory v = _locked(WEBAUTHN);
        uint256 releaseAfter = vault.coverages(v.coverage.coverageId).releaseAfter;
        vm.warp(releaseAfter + 1);
        KeelsonTypes.Verdict memory late = _verdict(v, AMOUNT, OPERATOR, "PP-D-late");
        bytes memory sigs = _sign2of2(late);
        vm.expectRevert(IKeelsonBondVault.CoverageNotActive.selector);
        vault.slash(late, treeSize, sigs);

        vm.warp(releaseAfter);
        _slash(_amber(v, AMOUNT));
        assertEq(pyusd.balanceOf(merchant), AMOUNT);
    }

    /// @dev I3: two disputes over one coverage never take more than it covers.
    function test_slash_twoDisputesCappedByCoverage() public {
        Vector memory v = _locked(WEBAUTHN);
        _slash(_verdict(v, 60e6, OPERATOR, "PP-D-first"));
        KeelsonTypes.Verdict memory second = _verdict(v, 40e6, OPERATOR, "PP-D-second");
        bytes memory sigs = _sign2of2(second);
        vm.expectRevert(IKeelsonBondVault.ExceedsCoverage.selector);
        vault.slash(second, treeSize, sigs);

        second.amount = v.coverage.amount - 60e6;
        _slash(second);
        assertEq(vault.slashed(v.coverage.coverageId), v.coverage.amount);
        assertEq(pyusd.balanceOf(merchant), v.coverage.amount);
    }

    function test_slash_wrongAgentReverts() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _amber(v, AMOUNT);
        verdict.agentId = agentId + 1;
        bytes memory sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonBondVault.CoverageNotActive.selector);
        vault.slash(verdict, treeSize, sigs);
    }

    function test_slash_signatureFromUnregisteredKeyReverts() public {
        Vector memory v = _locked(WEBAUTHN);
        KeelsonTypes.Verdict memory verdict = _amber(v, AMOUNT);
        (, uint256 stranger) = makeAddrAndKey("not a tee");
        bytes memory forged = bytes.concat(_signWith(tdxKey, verdict), _signWith(stranger, verdict));
        vm.expectRevert(IKeelsonBondVault.InvalidVerdictSignature.selector);
        vault.slash(verdict, treeSize, forged);

        forged = bytes.concat(_signWith(nitroKey, verdict), _signWith(tdxKey, verdict));
        vm.expectRevert(IKeelsonBondVault.InvalidVerdictSignature.selector);
        vault.slash(verdict, treeSize, forged);

        forged = _signWith(nitroKey, verdict);
        vm.expectRevert(IKeelsonBondVault.InvalidVerdictSignature.selector);
        vault.slash(verdict, treeSize, forged);
    }

    /// @dev Paxos freezes the merchant: the slash settles into a claim, which the merchant later sends elsewhere by
    /// signature through a relayer.
    function test_slash_frozenPayeeGoesToClaimable() public {
        Vector memory v = _locked(WEBAUTHN);
        _freeze(merchant);
        KeelsonTypes.Verdict memory verdict = _amber(v, AMOUNT);
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.PayoutFailed(verdict.disputeId, merchant, AMOUNT);
        _slash(verdict);
        assertEq(vault.claimable(merchant), AMOUNT);
        assertEq(pyusd.balanceOf(merchant), 0);
        assertTrue(vault.settled(verdict.disputeId));
        _assertBacked();

        address fresh = makeAddr("merchant's new account");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(merchantKey, merchant, fresh, 0, deadline, vault.domainSeparator());
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.Claimed(merchant, fresh, AMOUNT);
        vm.prank(makeAddr("relayer"));
        vault.claim(merchant, fresh, 0, deadline, sig);
        emit log_named_uint(
            "claim (signed) execution", _executionGas(abi.encodeCall(vault.claim, (merchant, fresh, 0, deadline, sig)))
        );
        assertEq(pyusd.balanceOf(fresh), AMOUNT);
        assertEq(vault.claimable(merchant), 0);

        vm.expectRevert();
        vault.claim(merchant, fresh, 0, deadline, sig);
    }

    function test_claim_toFrozenAddressKeepsTheClaim() public {
        Vector memory v = _locked(WEBAUTHN);
        _freeze(merchant);
        _slash(_amber(v, AMOUNT));
        vm.prank(merchant);
        vm.expectRevert();
        vault.claim(merchant, merchant, 0, 0, "");
        assertEq(vault.claimable(merchant), AMOUNT);
    }

    function test_claim_wrongSignerReverts() public {
        Vector memory v = _locked(WEBAUTHN);
        _freeze(merchant);
        _slash(_amber(v, AMOUNT));
        (, uint256 thief) = makeAddrAndKey("thief");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _signClaim(thief, merchant, makeAddr("thief"), 0, deadline, vault.domainSeparator());
        vm.expectRevert(IKeelsonBondVault.InvalidSignature.selector);
        vault.claim(merchant, makeAddr("thief"), 0, deadline, sig);
    }

    /// @dev Paxos freezes the vault itself: the slash still settles, into a claim, without reverting half-way.
    function test_slash_frozenVaultSettlesToClaimable() public {
        Vector memory v = _locked(WEBAUTHN);
        _freeze(address(vault));
        KeelsonTypes.Verdict memory verdict = _amber(v, AMOUNT);
        uint128 lockedBefore = _bond().locked;
        _slash(verdict);
        assertTrue(vault.settled(verdict.disputeId));
        assertEq(vault.claimable(merchant), AMOUNT);
        assertEq(_bond().locked, lockedBefore - AMOUNT);
        assertEq(pyusd.balanceOf(merchant), 0);
        _assertBacked();
    }
}
