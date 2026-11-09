// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {SlashBase} from "./utils/SlashBase.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Slashing one coverage of the 100-coverage batch (`vectors/coverage-batch.json`) with its Merkle proof, on a
/// fork of Arbitrum Sepolia.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract BondVaultBatchSlashForkTest is SlashBase {
    using stdJson for string;

    string internal json;
    KeelsonTypes.CoverageBatch internal batch;
    bytes32 internal batchId;
    KeelsonTypes.Coverage internal entry;
    bytes32[] internal proof;

    function setUp() public override {
        super.setUp();
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/coverage-batch.json"));
        batch = KeelsonTypes.CoverageBatch({
            agentId: json.readUint(".batch.agentId"),
            root: json.readBytes32(".batch.root"),
            total: uint128(json.readUint(".batch.total")),
            premium: uint96(json.readUint(".batch.premium")),
            expiresAt: uint40(json.readUint(".batch.expiresAt")),
            checkpointRoot: checkpointRoot,
            treeSize: treeSize
        });
        vm.warp(batch.expiresAt - vault.params().disputeWindow);
        batchId = vault.lockCoverageBatch(batch, _signVault(operatorKey, KeelsonTypes.hash(batch)));

        string memory c = ".proven.coverage";
        entry = KeelsonTypes.Coverage({
            coverageId: json.readBytes32(string.concat(c, ".coverageId")),
            agentId: json.readUint(string.concat(c, ".agentId")),
            merchant: json.readAddress(string.concat(c, ".merchant")),
            amount: uint96(json.readUint(string.concat(c, ".amount"))),
            premium: uint96(json.readUint(string.concat(c, ".premium"))),
            expiresAt: uint40(json.readUint(string.concat(c, ".expiresAt"))),
            mandateHash: json.readBytes32(string.concat(c, ".mandateHash")),
            amberCommitment: json.readBytes32(string.concat(c, ".amberCommitment")),
            userKeyHash: json.readBytes32(string.concat(c, ".userKeyHash"))
        });
        proof = json.readBytes32Array(".proven.proof");
        assertEq(json.readUint(".proven.index"), 37);
    }

    function _batchVerdict(KeelsonTypes.Coverage memory c, uint96 amount, string memory dispute)
        internal
        view
        returns (KeelsonTypes.Verdict memory)
    {
        return KeelsonTypes.Verdict({
            disputeId: keccak256(abi.encode(dispute, c.coverageId)),
            coverageId: c.coverageId,
            agentId: c.agentId,
            payee: merchant,
            amount: amount,
            ruleId: R61,
            liable: OPERATOR,
            fieldId: VARIANT_FIELD,
            evidenceHash: keccak256(abi.encode("evidence", dispute)),
            inputsHash: keccak256(abi.encode("inputs", dispute)),
            policySetHash: bytes32(0),
            checkpointRoot: checkpointRoot,
            issuedAt: uint40(vm.getBlockTimestamp()),
            deadline: uint40(vm.getBlockTimestamp() + 1 hours)
        });
    }

    function test_slashBatched_entry37Pays() public {
        KeelsonTypes.Verdict memory verdict = _batchVerdict(entry, entry.amount, "PP-D-batch-37");
        bytes memory sigs = _sign2of2(verdict);
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.Slashed(
            verdict.disputeId,
            entry.coverageId,
            agentId,
            merchant,
            entry.amount,
            VARIANT_FIELD,
            verdict.evidenceHash,
            _digest(verdict)
        );
        vault.slashBatched(verdict, treeSize, sigs, batchId, entry, proof);
        uint256 gSlashbatched100 =
            _executionGas(abi.encodeCall(vault.slashBatched, (verdict, treeSize, sigs, batchId, entry, proof)));
        emit log_named_uint("slashBatched execution, 100-leaf batch", gSlashbatched100);
        GasBudget.check("slashBatched_100", gSlashbatched100);
        assertEq(pyusd.balanceOf(merchant), entry.amount);
        assertEq(vault.batchSlashed(batchId), entry.amount);
        assertEq(vault.slashed(entry.coverageId), entry.amount);

        KeelsonTypes.Verdict memory again = _batchVerdict(entry, 1, "PP-D-batch-37-again");
        sigs = _sign2of2(again);
        vm.expectRevert(IKeelsonBondVault.ExceedsCoverage.selector);
        vault.slashBatched(again, treeSize, sigs, batchId, entry, proof);
    }

    function test_slashBatched_otherCoverageWithEntry37sProofReverts() public {
        KeelsonTypes.Coverage memory entry38 = entry;
        entry38.coverageId = keccak256(abi.encode(json.readBytes32(".proven.coverage.coverageId"), uint256(38)));
        KeelsonTypes.Verdict memory verdict = _batchVerdict(entry38, entry38.amount, "PP-D-batch-38");
        bytes memory sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonBondVault.NotInBatch.selector);
        vault.slashBatched(verdict, treeSize, sigs, batchId, entry38, proof);

        KeelsonTypes.Coverage memory inflated = entry;
        inflated.amount = uint96(batch.total);
        verdict = _batchVerdict(inflated, inflated.amount, "PP-D-batch-inflated");
        sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonBondVault.NotInBatch.selector);
        vault.slashBatched(verdict, treeSize, sigs, batchId, inflated, proof);
    }

    function test_slashBatched_thenReleaseReturnsTheRest() public {
        KeelsonTypes.Verdict memory verdict = _batchVerdict(entry, entry.amount, "PP-D-batch-37");
        vault.slashBatched(verdict, treeSize, _sign2of2(verdict), batchId, entry, proof);
        uint128 freeBefore = _bond().free;
        vm.warp(uint256(vault.batches(batchId).releaseAfter) + 1);
        vault.releaseBatch(batchId);
        assertEq(_bond().free, freeBefore + batch.total - entry.amount);
        assertEq(_bond().locked, 0);
        _assertBacked();
    }

    function test_slashBatched_queuedHoldsTheBatch() public {
        IKeelsonBondVault.Params memory p = vault.params();
        p.instantSlashCap = 0;
        _viaTimelock(address(vault), abi.encodeCall(vault.setParams, (p)));
        KeelsonTypes.Verdict memory verdict = _batchVerdict(entry, entry.amount, "PP-D-batch-37");
        vault.slashBatched(verdict, treeSize, _sign2of2(verdict), batchId, entry, proof);
        vm.warp(uint256(vault.batches(batchId).releaseAfter) + 1);
        vm.expectRevert(IKeelsonBondVault.SlashPending.selector);
        vault.releaseBatch(batchId);

        vm.prank(_json().readAddress(".contracts.GuardianSafe"));
        vm.expectRevert(IKeelsonBondVault.VetoClosed.selector);
        vault.vetoSlash(verdict.disputeId, "too late");
        vault.executeSlash(verdict.disputeId);
        vault.releaseBatch(batchId);
        assertEq(vault.batchSlashed(batchId), entry.amount);
        assertEq(pyusd.balanceOf(merchant), entry.amount);
    }

    function test_slashBatched_vetoRestoresTheBatch() public {
        IKeelsonBondVault.Params memory p = vault.params();
        p.instantSlashCap = 0;
        _viaTimelock(address(vault), abi.encodeCall(vault.setParams, (p)));
        KeelsonTypes.Verdict memory verdict = _batchVerdict(entry, entry.amount, "PP-D-batch-37");
        vault.slashBatched(verdict, treeSize, _sign2of2(verdict), batchId, entry, proof);
        vm.prank(_json().readAddress(".contracts.GuardianSafe"));
        vault.vetoSlash(verdict.disputeId, "wrong verdict");
        assertEq(vault.batchSlashed(batchId), 0);
        assertEq(vault.slashed(entry.coverageId), 0);
        assertEq(vault.pendingSlashes(agentId), 0);
    }

    /// @dev A batch leaf whose id is also a coverage locked on its own cannot be slashed through the batch: the two
    /// would share one `slashed` entry.
    function test_slashBatched_leafLockedOnItsOwnReverts() public {
        uint256 slot = uint256(keccak256(abi.encode(entry.coverageId, uint256(7))));
        vm.store(address(vault), bytes32(slot), bytes32(uint256(1) << 200));
        assertEq(uint8(vault.coverages(entry.coverageId).status), uint8(IKeelsonBondVault.Status.Active));
        KeelsonTypes.Verdict memory verdict = _batchVerdict(entry, entry.amount, "PP-D-batch-37");
        bytes memory sigs = _sign2of2(verdict);
        vm.expectRevert(IKeelsonBondVault.NotInBatch.selector);
        vault.slashBatched(verdict, treeSize, sigs, batchId, entry, proof);
    }
}
