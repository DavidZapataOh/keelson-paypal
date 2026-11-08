// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ICheckpointAnchor} from "./interfaces/ICheckpointAnchor.sol";
import {IVerdictVerifier} from "./interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "./libraries/KeelsonTypes.sol";
import {RFC6962} from "./libraries/RFC6962.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title CheckpointAnchor
/// @notice Anchors log checkpoints that both TEE legs signed and that extend the latest anchor of their origin, so a
/// rewritten history cannot be anchored. It has no owner and no upgrade path; anyone may submit an anchor.
contract CheckpointAnchor is ICheckpointAnchor {
    /// @dev Longest consistency proof between two trees of up to 2^64 - 1 leaves (RFC 9162 §2.1.4.1).
    uint256 internal constant MAX_PROOF = 65;
    uint256 internal constant MAX_NOTE = 8192;

    /// @inheritdoc ICheckpointAnchor
    IVerdictVerifier public immutable verifier;

    mapping(bytes32 origin => Anchor) internal _latest;
    /// @inheritdoc ICheckpointAnchor
    mapping(bytes32 origin => mapping(uint64 size => bytes32 root)) public rootAt;

    constructor(IVerdictVerifier verifier_) {
        verifier = verifier_;
    }

    /// @inheritdoc ICheckpointAnchor
    function latest(bytes32 origin) external view returns (uint64 size, bytes32 root, uint40 anchoredAt) {
        Anchor memory a = _latest[origin];
        return (a.size, rootAt[origin][a.size], a.anchoredAt);
    }

    /// @inheritdoc ICheckpointAnchor
    function anchor(
        bytes32 origin,
        uint64 size,
        bytes32 root,
        bytes32[] calldata consistency,
        bytes calldata teeSigs,
        bytes calldata signedNote
    ) external {
        if (size == 0 || root == 0) revert EmptyTree();
        Anchor memory last = _latest[origin];
        if (size <= last.size) {
            bytes32 anchored = rootAt[origin][size];
            if (anchored == root) revert AlreadyAnchored();
            if (anchored != 0) revert InconsistentCheckpoint();
            revert StaleCheckpoint();
        }
        if (!_noteStates(origin, size, root, signedNote)) revert NoteMismatch();
        bytes32 digest = verifier.hashTypedData(
            KeelsonTypes.hash(KeelsonTypes.Checkpoint({origin: origin, treeSize: size, rootHash: root}))
        );
        if (!verifier.verify2of2(digest, teeSigs)) revert UnauthorizedCheckpoint();
        // RFC 9162 §2.1.4: every tree is consistent with the empty tree, so the first anchor takes no proof.
        bool consistent = last.size == 0
            ? consistency.length == 0
            : consistency.length <= MAX_PROOF
                && RFC6962.verifyConsistency(last.size, size, rootAt[origin][last.size], root, consistency);
        if (!consistent) revert InconsistentCheckpoint();

        rootAt[origin][size] = root;
        _latest[origin] = Anchor({size: size, anchoredAt: SafeCast.toUint40(block.timestamp)});
        // forge-lint: disable-next-line(reentrancy-events)
        emit CheckpointAnchored(origin, size, root, keccak256(signedNote));
    }

    /// @inheritdoc ICheckpointAnchor
    function verifyInclusion(bytes32 origin, uint64 size, uint64 index, bytes32 leafHash, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        bytes32 anchored = rootAt[origin][size];
        if (anchored == 0) return false;
        (bytes32 computed, bool ok) = RFC6962.rootFromInclusion(index, size, leafHash, proof);
        return ok && computed == anchored;
    }

    /// @dev Whether the note's first line hashes to `origin` and the next bytes are exactly the tlog-checkpoint body
    /// `<size>\n<base64 root>\n` with no extension lines, followed by the signed-note separator `\n`.
    function _noteStates(bytes32 origin, uint64 size, bytes32 root, bytes calldata note) internal pure returns (bool) {
        if (note.length > MAX_NOTE) return false;
        uint256 newline = 0;
        assembly ("memory-safe") {
            for {} and(lt(newline, note.length), iszero(eq(byte(0, calldataload(add(note.offset, newline))), 0x0a))) {}
            {
                newline := add(newline, 1)
            }
        }
        if (newline == note.length || keccak256(note[:newline]) != origin) return false;
        bytes memory body =
            bytes.concat(bytes(Strings.toString(size)), "\n", bytes(Base64.encode(abi.encodePacked(root))), "\n\n");
        uint256 start = newline + 1;
        return note.length >= start + body.length && keccak256(note[start:start + body.length]) == keccak256(body);
    }
}
