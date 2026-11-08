// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ICheckpointAnchor} from "../src/interfaces/ICheckpointAnchor.sol";
import {AnchorBase} from "./utils/AnchorBase.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @notice Anchoring with the live legs' real signatures over real sandbox and conformance checkpoints.
contract CheckpointAnchorTest is AnchorBase {
    /// @dev secp256k1 group order.
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    struct Latest {
        uint64 size;
        bytes32 root;
        uint40 anchoredAt;
    }

    function _latest(bytes32 origin) internal view returns (Latest memory l) {
        (l.size, l.root, l.anchoredAt) = anchors.latest(origin);
    }

    function _assertLatest(Case memory c) internal view {
        Latest memory l = _latest(c.originHash);
        assertEq(l.size, c.size);
        assertEq(l.root, c.root);
    }

    function _none() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    function _expectRevert(bytes4 selector, Case memory c, bytes32[] memory proof, bytes memory sigs, bytes memory note)
        internal
    {
        vm.expectRevert(selector);
        anchors.anchor(c.originHash, uint64(c.size), c.root, proof, sigs, note);
    }

    function test_vectorsAreTheExpectedCases() public view {
        string[7] memory names = [
            "sandbox",
            "conformance-8",
            "conformance-16",
            "fork-8",
            "fork-16",
            "conformance-gas-from",
            "conformance-gas-to"
        ];
        for (uint256 i; i < names.length; ++i) {
            Case memory c = _case(i);
            assertEq(c.name, names[i]);
            assertEq(c.originHash, keccak256(bytes(c.origin)));
        }
        assertEq(_case(SANDBOX).origin, "log.keelson.finance/alibi/2026-1");
        assertEq(_case(CONFORMANCE_8).origin, "log.keelson.finance/conformance/2026-1");
    }

    function test_anchorsSandboxAndExtendsConformance() public {
        Case memory sandbox = _case(SANDBOX);
        Case memory a = _case(CONFORMANCE_8);
        Case memory b = _case(CONFORMANCE_16);
        vm.expectEmit(address(anchors));
        emit ICheckpointAnchor.CheckpointAnchored(
            sandbox.originHash, uint64(sandbox.size), sandbox.root, keccak256(bytes(sandbox.signedNote))
        );
        _anchor(sandbox);
        _assertLatest(sandbox);
        assertEq(_latest(sandbox.originHash).anchoredAt, vm.getBlockTimestamp());

        _anchor(a);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.expectEmit(address(anchors));
        emit ICheckpointAnchor.CheckpointAnchored(b.originHash, uint64(b.size), b.root, keccak256(bytes(b.signedNote)));
        _anchor(b);
        _assertLatest(b);
        assertEq(_latest(b.originHash).anchoredAt, vm.getBlockTimestamp());
        assertEq(anchors.rootAt(a.originHash, uint64(a.size)), a.root);
        assertEq(anchors.rootAt(b.originHash, uint64(b.size)), b.root);
        _assertLatest(sandbox);
    }

    function test_sizeZeroReverts() public {
        Case memory a = _case(SANDBOX);
        vm.expectRevert(ICheckpointAnchor.EmptyTree.selector);
        anchors.anchor(a.originHash, 0, a.root, _none(), _sigs(a), bytes(a.signedNote));
        vm.expectRevert(ICheckpointAnchor.EmptyTree.selector);
        anchors.anchor(a.originHash, uint64(a.size), bytes32(0), _none(), _sigs(a), bytes(a.signedNote));
    }

    function test_firstAnchorTakesNoProof() public {
        Case memory c = _case(CONFORMANCE_16);
        _expectRevert(
            ICheckpointAnchor.InconsistentCheckpoint.selector,
            c,
            c.consistencyFromPrevious,
            _sigs(c),
            bytes(c.signedNote)
        );
    }

    // ---------------------------------------------------------------- a rewritten history

    function test_rewrittenRootReverts() public {
        Case memory t8 = _case(CONFORMANCE_8);
        Case memory fork16 = _case(FORK_16);
        _anchor(t8);
        _expectRevert(
            ICheckpointAnchor.InconsistentCheckpoint.selector,
            fork16,
            fork16.consistencyFromPrevious,
            _sigs(fork16),
            bytes(fork16.signedNote)
        );
        _assertLatest(t8);
    }

    function test_secondRootForAnchoredSizeReverts() public {
        Case memory t16 = _case(CONFORMANCE_16);
        Case memory fork8 = _case(FORK_8);
        Case memory fork16 = _case(FORK_16);
        _anchor(t16, _none());

        _expectRevert(ICheckpointAnchor.StaleCheckpoint.selector, fork8, _none(), _sigs(fork8), bytes(fork8.signedNote));
        _expectRevert(ICheckpointAnchor.AlreadyAnchored.selector, t16, _none(), _sigs(t16), bytes(t16.signedNote));
        _expectRevert(
            ICheckpointAnchor.InconsistentCheckpoint.selector, fork16, _none(), _sigs(fork16), bytes(fork16.signedNote)
        );
        _assertLatest(t16);
        assertEq(anchors.rootAt(fork8.originHash, 8), bytes32(0));
    }

    function test_brokenProofsRevert() public {
        Case memory t8 = _case(CONFORMANCE_8);
        Case memory t16 = _case(CONFORMANCE_16);
        _anchor(t8);
        bytes32[] memory proof = t16.consistencyFromPrevious;
        assertGt(proof.length, 0);

        for (uint256 k; k < proof.length; ++k) {
            bytes32[] memory flipped = _copy(proof, proof.length);
            flipped[k] ^= bytes32(uint256(1));
            _expectRevert(
                ICheckpointAnchor.InconsistentCheckpoint.selector, t16, flipped, _sigs(t16), bytes(t16.signedNote)
            );
        }
        _expectRevert(
            ICheckpointAnchor.InconsistentCheckpoint.selector,
            t16,
            _copy(proof, proof.length - 1),
            _sigs(t16),
            bytes(t16.signedNote)
        );
        bytes32[] memory tooLong = new bytes32[](66);
        for (uint256 k; k < proof.length; ++k) {
            tooLong[k] = proof[k];
        }
        _expectRevert(
            ICheckpointAnchor.InconsistentCheckpoint.selector, t16, tooLong, _sigs(t16), bytes(t16.signedNote)
        );
        _assertLatest(t8);

        _anchor(t16);
        _assertLatest(t16);
    }

    function _copy(bytes32[] memory p, uint256 n) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](n);
        for (uint256 k; k < n; ++k) {
            out[k] = p[k];
        }
    }

    // ---------------------------------------------------------------- both TEEs

    function _highS(bytes memory sig) internal pure returns (bytes memory out) {
        out = bytes.concat(sig);
        bytes32 s;
        assembly ("memory-safe") {
            s := mload(add(out, 0x40))
        }
        bytes32 flipped = bytes32(N - uint256(s));
        assembly ("memory-safe") {
            mstore(add(out, 0x40), flipped)
        }
        out[64] = out[64] == bytes1(uint8(27)) ? bytes1(uint8(28)) : bytes1(uint8(27));
    }

    function test_withoutBothTeesReverts() public {
        Case memory a = _case(SANDBOX);
        Case memory b = _case(CONFORMANCE_8);
        bytes memory note = bytes(a.signedNote);
        bytes4 unauthorized = ICheckpointAnchor.UnauthorizedCheckpoint.selector;
        _expectRevert(unauthorized, a, _none(), a.sigTdx, note);
        _expectRevert(unauthorized, a, _none(), bytes.concat(a.sigTdx, a.sigTdx), note);
        _expectRevert(unauthorized, a, _none(), bytes.concat(a.sigNitro, a.sigNitro), note);
        _expectRevert(unauthorized, a, _none(), bytes.concat(a.sigNitro, a.sigTdx), note);
        _expectRevert(unauthorized, a, _none(), bytes.concat(_highS(a.sigTdx), a.sigNitro), note);
        _expectRevert(unauthorized, a, _none(), bytes.concat(a.sigTdx, _highS(a.sigNitro)), note);
        _expectRevert(unauthorized, b, _none(), _sigs(a), bytes(b.signedNote));
        assertEq(_latest(a.originHash).size, 0);
        _anchor(a);
    }

    function test_revokedSignerReverts() public {
        Case memory a = _case(SANDBOX);
        _guardianExec(address(verifier), abi.encodeCall(verifier.revokeSigner, (nitroSigner)));
        _expectRevert(ICheckpointAnchor.UnauthorizedCheckpoint.selector, a, _none(), _sigs(a), bytes(a.signedNote));
    }

    function test_expiredSignerReverts() public {
        Case memory a = _case(SANDBOX);
        vm.warp(vm.getBlockTimestamp() + verifier.SIGNER_TTL());
        _expectRevert(ICheckpointAnchor.UnauthorizedCheckpoint.selector, a, _none(), _sigs(a), bytes(a.signedNote));
    }

    // ---------------------------------------------------------------- the note

    function test_noteMustStateTheCheckpoint() public {
        Case memory a = _case(SANDBOX);
        Case memory b = _case(CONFORMANCE_8);
        string memory note = a.signedNote;
        string memory size = string.concat("\n", vm.toString(a.size), "\n");
        string memory root = Base64.encode(abi.encodePacked(a.root));
        bytes4 mismatch = ICheckpointAnchor.NoteMismatch.selector;
        bytes memory sigs = _sigs(a);

        _expectRevert(mismatch, a, _none(), sigs, bytes(b.signedNote));
        _expectRevert(mismatch, a, _none(), sigs, bytes(vm.replace(note, "/alibi/2026-1\n", "/alibi/2026-2\n")));
        _expectRevert(
            mismatch,
            a,
            _none(),
            sigs,
            bytes(vm.replace(note, size, string.concat("\n", vm.toString(a.size + 1), "\n")))
        );
        _expectRevert(
            mismatch,
            a,
            _none(),
            sigs,
            bytes(
                vm.replace(
                    note, string.concat(root, "\n"), string.concat(Base64.encode(abi.encodePacked(b.root)), "\n")
                )
            )
        );
        _expectRevert(
            mismatch,
            a,
            _none(),
            sigs,
            bytes(vm.replace(note, string.concat(root, "\n\n"), string.concat(root, "\nextension\n\n")))
        );
        _expectRevert(
            mismatch, a, _none(), sigs, bytes(vm.replace(note, string.concat(root, "\n\n"), string.concat(root, "\n")))
        );
        bytes memory long = bytes.concat(bytes(note), new bytes(8193 - bytes(note).length));
        _expectRevert(mismatch, a, _none(), sigs, long);
        bytes memory longest = bytes.concat(bytes(note), new bytes(8192 - bytes(note).length));
        anchors.anchor(a.originHash, uint64(a.size), a.root, _none(), sigs, longest);
    }

    // ---------------------------------------------------------------- inclusion

    struct Inclusion {
        uint256 index;
        bytes32 leafHash;
        bool ok;
        bytes32[] proof;
        bytes32 root;
        uint256 size;
    }

    function test_verifyInclusionOfSandboxLeaves() public {
        Case memory c = _case(SANDBOX);
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/rfc6962.json"));
        assertEq(vm.parseJsonUint(json, ".sandboxSize"), c.size);
        Inclusion[] memory leaves = abi.decode(vm.parseJson(json, ".sandboxInclusion"), (Inclusion[]));
        assertEq(leaves.length, 3);

        uint64 size = uint64(c.size);
        bytes32 origin = c.originHash;
        assertFalse(anchors.verifyInclusion(origin, size, uint64(leaves[0].index), leaves[0].leafHash, leaves[0].proof));
        _anchor(c);
        for (uint256 i; i < leaves.length; ++i) {
            Inclusion memory l = leaves[i];
            assertEq(l.root, c.root);
            assertTrue(anchors.verifyInclusion(origin, size, uint64(l.index), l.leafHash, l.proof));
            assertFalse(anchors.verifyInclusion(origin, size - 1, uint64(l.index), l.leafHash, l.proof));
            assertFalse(
                anchors.verifyInclusion(origin, size, uint64(l.index), l.leafHash ^ bytes32(uint256(1)), l.proof)
            );
            assertFalse(anchors.verifyInclusion(origin, size, size, l.leafHash, l.proof));
            assertFalse(
                anchors.verifyInclusion(origin, size, uint64(l.index), l.leafHash, _copy(l.proof, l.proof.length - 1))
            );
        }
    }
}
