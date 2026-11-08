// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../../script/CoverageVector.sol";
import {IKeelsonBondVault} from "../../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {LockBase} from "./VaultBase.sol";
import {VerdictSigners} from "./VerdictSigners.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Coverages locked from the live vectors on a fork of Arbitrum Sepolia, and verdicts against them that name a
/// checkpoint the real `CheckpointAnchor` holds for the vault's log.
abstract contract SlashBase is LockBase, VerdictSigners {
    using stdJson for string;

    uint8 internal constant OPERATOR = 1;
    uint8 internal constant KEELSON = 2;
    /// @dev SPEC rule ids: R61 the operator exceeded the mandate (amber), R60 a covered purchase Keelson answers for.
    uint8 internal constant R61 = 61;
    uint8 internal constant R60 = 60;
    /// @dev `FIELD_BITS.variant` in `@keelson/core`: the size the operator bought differs from the mandate's.
    uint8 internal constant VARIANT_FIELD = 9;

    uint256 internal deposited;
    address internal merchant;
    uint256 internal merchantKey;
    /// @dev The sandbox log's anchored checkpoint at the fork block.
    uint64 internal treeSize;
    bytes32 internal checkpointRoot;

    function setUp() public virtual override {
        super.setUp();
        deposited = _depositAll();
        _installVerdictSigners(vault.verifier());
        (merchant, merchantKey) = makeAddrAndKey("merchant");
        (treeSize, checkpointRoot,) = vault.anchor().latest(vault.logOrigin());
        assertGt(treeSize, 0, "anchored checkpoint");
    }

    /// @dev Locked at its countersign's issue time, as the relayer submits it.
    function _locked(string memory name) internal returns (Vector memory v) {
        v = _vector(name);
        vm.warp(v.countersign.issuedAt);
        _lock(v);
    }

    function _verdict(Vector memory v, uint96 amount, uint8 liable, string memory dispute)
        internal
        view
        returns (KeelsonTypes.Verdict memory)
    {
        return KeelsonTypes.Verdict({
            disputeId: keccak256(abi.encode(dispute, v.coverage.coverageId)),
            coverageId: v.coverage.coverageId,
            agentId: v.coverage.agentId,
            payee: merchant,
            amount: amount,
            ruleId: liable == OPERATOR ? R61 : R60,
            liable: liable,
            fieldId: VARIANT_FIELD,
            evidenceHash: keccak256(abi.encode("evidence", dispute)),
            inputsHash: keccak256(abi.encode("inputs", dispute)),
            policySetHash: v.countersign.policySetHash,
            checkpointRoot: checkpointRoot,
            issuedAt: uint40(vm.getBlockTimestamp()),
            deadline: uint40(vm.getBlockTimestamp() + 1 hours)
        });
    }

    function _amber(Vector memory v, uint96 amount) internal view returns (KeelsonTypes.Verdict memory) {
        return _verdict(v, amount, OPERATOR, "PP-D-amber");
    }

    function _slash(KeelsonTypes.Verdict memory v) internal {
        vault.slash(v, treeSize, _sign2of2(v));
    }

    function _digest(KeelsonTypes.Verdict memory v) internal view returns (bytes32) {
        return vault.verifier().hashTypedData(KeelsonTypes.hash(v));
    }

    function _signClaim(uint256 pk, address account, address to, uint256 nonce, uint256 deadline, bytes32 domain)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", domain, KeelsonTypes.hashClaim(account, to, nonce, deadline)));
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, sv);
    }

    /// @dev I4: every bond and every claim is backed by the vault's PYUSD.
    function _assertBacked() internal view {
        IKeelsonBondVault.Bond memory b = _bond();
        assertLe(
            uint256(b.free) + b.locked + b.queued + vault.claimable(merchant), pyusd.balanceOf(address(vault)), "I4"
        );
    }
}
