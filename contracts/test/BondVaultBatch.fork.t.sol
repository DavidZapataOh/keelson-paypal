// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ICheckpointAnchor} from "../src/interfaces/ICheckpointAnchor.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {VaultBase} from "./utils/VaultBase.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Scale mode on a fork of Arbitrum Sepolia: a batch of 100 coverages (`vectors/coverage-batch.json`, built by the
/// chain package's `coverageBatch`) locked against the sandbox log's checkpoint the live legs signed and the `CheckpointAnchor`
/// anchored.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract BondVaultBatchForkTest is VaultBase {
    using stdJson for string;

    string internal json;
    KeelsonTypes.CoverageBatch internal batch;
    uint40 internal issuedAt;

    function setUp() public override {
        super.setUp();
        _depositAll();
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/coverage-batch.json"));
        (uint64 size, bytes32 root,) = vault.anchor().latest(vault.logOrigin());
        assertGt(size, 0, "sandbox log anchored at the fork block");
        batch = KeelsonTypes.CoverageBatch({
            agentId: json.readUint(".batch.agentId"),
            root: json.readBytes32(".batch.root"),
            total: uint128(json.readUint(".batch.total")),
            premium: uint96(json.readUint(".batch.premium")),
            expiresAt: uint40(json.readUint(".batch.expiresAt")),
            checkpointRoot: root,
            treeSize: size
        });
        assertEq(batch.agentId, agentId);
        vm.warp(batch.expiresAt - vault.params().disputeWindow);
    }

    function _sig(KeelsonTypes.CoverageBatch memory b) internal view returns (bytes memory) {
        return _signVault(operatorKey, KeelsonTypes.hash(b));
    }

    function test_lockBatch() public {
        bytes memory sig = _sig(batch);
        bytes32 batchId = KeelsonTypes.hash(batch);
        uint128 freeBefore = _bond().free;
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.CoverageBatchLocked(
            batchId, agentId, batch.root, batch.total, batch.premium, batch.checkpointRoot, batch.treeSize
        );
        assertEq(vault.lockCoverageBatch(batch, sig), batchId);
        uint256 gas = _executionGas(abi.encodeCall(vault.lockCoverageBatch, (batch, sig)));
        emit log_named_uint("lockCoverageBatch execution, 100 coverages", gas);
        emit log_named_uint("lockCoverageBatch execution per coverage", gas / json.readUint(".count"));
        GasBudget.check("lockCoverageBatch_perCoverage", gas / json.readUint(".count"));

        IKeelsonBondVault.BatchState memory s = vault.batches(batchId);
        assertEq(s.locked, batch.total);
        assertEq(s.agentId, agentId);
        assertEq(s.releaseAfter, batch.expiresAt + vault.params().grace);
        assertEq(uint8(s.status), uint8(IKeelsonBondVault.Status.Active));
        assertEq(vault.batchRoot(batchId), batch.root);
        assertEq(_bond().locked, batch.total);
        assertEq(_bond().free, freeBefore - batch.total - batch.premium);
    }

    function test_proofOfEntry37() public view {
        string memory c = ".proven.coverage";
        KeelsonTypes.Coverage memory coverage = KeelsonTypes.Coverage({
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
        assertEq(json.readUint(".proven.index"), 37);
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(KeelsonTypes.hash(coverage)))));
        assertTrue(MerkleProof.verify(json.readBytes32Array(".proven.proof"), batch.root, leaf));
        coverage.amount += 1;
        leaf = keccak256(bytes.concat(keccak256(abi.encode(KeelsonTypes.hash(coverage)))));
        assertFalse(MerkleProof.verify(json.readBytes32Array(".proven.proof"), batch.root, leaf));
    }

    function test_lockBatch_notAnchoredReverts() public {
        KeelsonTypes.CoverageBatch memory b = batch;
        b.checkpointRoot = keccak256("a root never anchored");
        bytes memory sig = _sig(b);
        vm.expectRevert(IKeelsonBondVault.NotAnchored.selector);
        vault.lockCoverageBatch(b, sig);

        b = batch;
        b.treeSize += 1;
        sig = _sig(b);
        vm.expectRevert(IKeelsonBondVault.NotAnchored.selector);
        vault.lockCoverageBatch(b, sig);
    }

    /// @dev A zero root never counts as anchored, though `rootAt` reads zero for every size not anchored.
    function test_lockBatch_zeroRootReverts() public {
        KeelsonTypes.CoverageBatch memory b = batch;
        b.checkpointRoot = 0;
        b.treeSize += 1;
        assertEq(vault.anchor().rootAt(vault.logOrigin(), b.treeSize), 0);
        bytes memory sig = _sig(b);
        vm.expectRevert(IKeelsonBondVault.NotAnchored.selector);
        vault.lockCoverageBatch(b, sig);
    }

    /// @dev A batch that ends now is expired, not merely too short.
    function test_lockBatch_atExpiryReverts() public {
        vm.warp(batch.expiresAt);
        bytes memory sig = _sig(batch);
        vm.expectRevert(IKeelsonBondVault.Expired.selector);
        vault.lockCoverageBatch(batch, sig);
    }

    function test_lockBatch_twiceReverts() public {
        bytes memory sig = _sig(batch);
        vault.lockCoverageBatch(batch, sig);
        vm.expectRevert(IKeelsonBondVault.BatchExists.selector);
        vault.lockCoverageBatch(batch, sig);
    }

    function test_lockBatch_otherSignerReverts() public {
        (, uint256 funderKey) = _funder(1);
        bytes memory sig = _signVault(funderKey, KeelsonTypes.hash(batch));
        vm.expectRevert(IKeelsonBondVault.InvalidOperatorSignature.selector);
        vault.lockCoverageBatch(batch, sig);
    }

    function test_lockBatch_windowTooShortReverts() public {
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes memory sig = _sig(batch);
        vm.expectRevert(IKeelsonBondVault.WindowTooShort.selector);
        vault.lockCoverageBatch(batch, sig);
    }

    function test_releaseBatch() public {
        bytes32 batchId = vault.lockCoverageBatch(batch, _sig(batch));
        uint40 releaseAfter = vault.batches(batchId).releaseAfter;
        vm.warp(releaseAfter);
        vm.expectRevert(IKeelsonBondVault.NotReleasable.selector);
        vault.releaseBatch(batchId);

        vm.warp(uint256(releaseAfter) + 1);
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.CoverageBatchReleased(batchId, agentId, batch.total);
        vault.releaseBatch(batchId);
        assertEq(_bond().locked, 0);
        assertEq(uint8(vault.batches(batchId).status), uint8(IKeelsonBondVault.Status.Released));
        vm.expectRevert(IKeelsonBondVault.NotReleasable.selector);
        vault.releaseBatch(batchId);
    }

    function test_anchorIsTheDeployedOne() public view {
        ICheckpointAnchor anchor = vault.anchor();
        assertEq(address(anchor), _json().readAddress(".contracts.CheckpointAnchor"));
        assertEq(vault.logOrigin(), keccak256(bytes(_json().readString(".params.logOrigin"))));
    }
}
