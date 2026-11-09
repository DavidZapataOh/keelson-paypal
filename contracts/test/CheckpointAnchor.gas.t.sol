// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {RFC6962Harness} from "./RFC6962.t.sol";
import {AnchorBase} from "./utils/AnchorBase.sol";
import {GasBudget} from "./utils/GasBudget.sol";

/// @notice Execution gas of `anchor` and `verifyInclusion` with real notes and the live legs' signatures.
contract CheckpointAnchorGasTest is AnchorBase {
    struct Consistency {
        bool ok;
        bytes32[] proof;
        bytes32 root1;
        bytes32 root2;
        uint256 size1;
        uint256 size2;
    }

    struct Inclusion {
        uint256 index;
        bytes32 leafHash;
        bool ok;
        bytes32[] proof;
        bytes32 root;
        uint256 size;
    }

    /// @dev `isolate` runs each call as its own transaction, so `gasTotalUsed` includes the intrinsic 21,000 and the
    /// calldata (EIP-2028); execution is what is left.
    function _measured(Case memory c, bytes32[] memory proof, string memory label)
        internal
        returns (uint256 execution)
    {
        bytes memory sigs = _sigs(c);
        bytes memory note = bytes(c.signedNote);
        anchors.anchor(c.originHash, uint64(c.size), c.root, proof, sigs, note);
        uint256 total = vm.lastCallGas().gasTotalUsed;
        assertEq(anchors.rootAt(c.originHash, uint64(c.size)), c.root);
        bytes memory data = abi.encodeCall(anchors.anchor, (c.originHash, uint64(c.size), c.root, proof, sigs, note));
        uint256 intrinsic = 21_000;
        for (uint256 i; i < data.length; ++i) {
            intrinsic += data[i] == 0 ? 4 : 16;
        }
        execution = total - intrinsic;
        emit log_named_uint(string.concat(label, ", transaction"), total);
        emit log_named_uint(string.concat(label, ", execution"), execution);
    }

    function test_gas_firstAnchor() public {
        Case memory c = _case(CONFORMANCE_8);
        _measured(c, c.consistencyFromPrevious, "anchor, first");
    }

    /// @dev The sandbox note carries the log's ML-DSA-44 signature (about 4 KiB), so the EIP-7623 calldata floor sets
    /// the transaction's gas and execution cannot be read from it.
    function test_gas_firstAnchorSandbox() public {
        Case memory c = _case(SANDBOX);
        anchors.anchor(c.originHash, uint64(c.size), c.root, c.consistencyFromPrevious, _sigs(c), bytes(c.signedNote));
        emit log_named_uint("anchor, first (sandbox), transaction", vm.lastCallGas().gasTotalUsed);
        emit log_named_uint("sandbox note bytes", bytes(c.signedNote).length);
    }

    function test_gas_anchorConformanceExtension() public {
        Case memory a = _case(CONFORMANCE_8);
        Case memory b = _case(CONFORMANCE_16);
        _anchor(a);
        GasBudget.check("anchor_extension", _measured(b, b.consistencyFromPrevious, "anchor, 8 to 16"));
    }

    function test_gas_anchorWith20NodeProof() public {
        Case memory from = _case(GAS_FROM);
        Case memory to = _case(GAS_TO);
        assertEq(to.consistencyFromPrevious.length, 20);
        _anchor(from);
        GasBudget.check("anchor_20NodeProof", _measured(to, to.consistencyFromPrevious, "anchor, 20-node proof"));
    }

    function test_gas_verifyInclusion20() public {
        Case memory from = _case(GAS_FROM);
        Case memory to = _case(GAS_TO);
        _anchor(from);
        _anchor(to);
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/rfc6962.json"));
        Inclusion memory v = abi.decode(vm.parseJson(json, ".gasInclusion"), (Inclusion));
        assertEq(v.proof.length, 20);
        assertEq(v.root, to.root);
        bool ok = anchors.verifyInclusion(to.originHash, uint64(v.size), uint64(v.index), v.leafHash, v.proof);
        uint256 used = vm.lastCallGas().gasTotalUsed;
        assertTrue(ok);
        emit log_named_uint("verifyInclusion, 20 nodes", used);
    }

    function test_gas_verifyConsistency20() public {
        RFC6962Harness lib = new RFC6962Harness();
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/rfc6962.json"));
        Consistency memory v = abi.decode(vm.parseJson(json, ".gasConsistency"), (Consistency));
        bool ok = lib.verifyConsistency(uint64(v.size1), uint64(v.size2), v.root1, v.root2, v.proof);
        uint256 used = vm.lastCallGas().gasTotalUsed;
        assertTrue(ok);
        emit log_named_uint("RFC6962.verifyConsistency, 20 nodes", used);
    }
}
