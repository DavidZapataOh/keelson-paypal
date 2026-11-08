// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IVerdictVerifier} from "./IVerdictVerifier.sol";

/// @title ICheckpointAnchor
/// @notice On-chain witness of the Keelson logs: it keeps, per log origin, the checkpoints both TEE legs signed, each
/// proven consistent with the one anchored before it.
/// @dev Any origin whose checkpoint both legs signed can be anchored, including test origins whose checkpoints the legs
/// sign without witnesses. A consumer must pin the origin it trusts and never take it from calldata.
interface ICheckpointAnchor {
    /// @notice The latest anchor of an origin, in one slot; its root is `rootAt(origin, size)`.
    struct Anchor {
        uint64 size;
        uint40 anchoredAt;
    }

    /// @param origin `keccak256` of the origin string.
    /// @param noteHash `keccak256` of the signed note passed to `anchor`, which the transaction's calldata carries. Only
    /// its origin line and body are checked on-chain; its log and witness signatures are for off-chain verifiers.
    event CheckpointAnchored(bytes32 indexed origin, uint64 size, bytes32 root, bytes32 noteHash);

    /// @notice The proof does not link the checkpoint to the latest anchor, or another root is anchored at its size.
    error InconsistentCheckpoint();
    /// @notice The same root is already anchored at this size.
    error AlreadyAnchored();
    /// @notice The checkpoint is smaller than the latest anchor and was never anchored.
    error StaleCheckpoint();
    /// @notice The signatures are not one active TDX signer's and one active Nitro signer's over the `Checkpoint`.
    error UnauthorizedCheckpoint();
    /// @notice The signed note does not state this origin, size and root, or is longer than 8 KiB.
    error NoteMismatch();
    /// @notice A tree of size zero, or a zero root, is never anchored.
    error EmptyTree();

    /// @notice The registry whose signers authenticate checkpoints, and whose EIP-712 domain they sign under.
    function verifier() external view returns (IVerdictVerifier);

    function latest(bytes32 origin) external view returns (uint64 size, bytes32 root, uint40 anchoredAt);

    /// @notice The root anchored for `origin` at `size`, or zero.
    function rootAt(bytes32 origin, uint64 size) external view returns (bytes32);

    /// @notice Anchors the checkpoint `(origin, size, root)`.
    /// @param consistency The RFC 6962 consistency proof from the latest anchor of `origin`; empty for its first anchor.
    /// @param teeSigs The TDX and the Nitro signature over the EIP-712 `Checkpoint`, `r ‖ s ‖ v` each (130 bytes).
    /// @param signedNote The c2sp.org/tlog-checkpoint signed note of the checkpoint; its first line must hash to `origin`
    /// and its body must state `size` and `root`.
    function anchor(
        bytes32 origin,
        uint64 size,
        bytes32 root,
        bytes32[] calldata consistency,
        bytes calldata teeSigs,
        bytes calldata signedNote
    ) external;

    /// @notice Whether `proof` includes the leaf hash `leafHash` at `index` in the anchored tree of `origin` at `size`.
    /// False when nothing is anchored at that size.
    function verifyInclusion(bytes32 origin, uint64 size, uint64 index, bytes32 leafHash, bytes32[] calldata proof)
        external
        view
        returns (bool);
}
