// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title RFC6962
/// @notice Merkle consistency and inclusion proofs of RFC 9162 §2.1.4.2 and §2.1.3.2 over the RFC 6962 tree hash,
/// where an interior node is `SHA-256(0x01 ‖ left ‖ right)`.
library RFC6962 {
    /// @notice `SHA-256(0x01 ‖ l ‖ r)`, through the SHA-256 precompile.
    function hashChildren(bytes32 l, bytes32 r) internal view returns (bytes32 h) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore8(m, 0x01)
            mstore(add(m, 0x01), l)
            mstore(add(m, 0x21), r)
            // The precompile fails only out of gas.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if iszero(staticcall(gas(), 0x02, m, 0x41, 0x00, 0x20)) { revert(0x00, 0x00) }
            h := mload(0x00)
        }
    }

    /// @notice Whether `proof` shows the tree of `size2` leaves with root `root2` extends the tree of `size1` leaves with
    /// root `root1`. False for `size1 == 0`, which is not a tree a proof can start from.
    function verifyConsistency(uint64 size1, uint64 size2, bytes32 root1, bytes32 root2, bytes32[] calldata proof)
        internal
        view
        returns (bool)
    {
        if (size1 == 0 || size1 > size2) return false;
        if (size1 == size2) return root1 == root2 && proof.length == 0;
        if (proof.length == 0) return false;

        uint64 fn = size1 - 1;
        uint64 sn = size2 - 1;
        // With size1 a power of two the old root is the first node, which the proof omits.
        bool rootFirst = size1 & fn == 0;
        uint256 i = 0;
        bytes32 fr;
        if (rootFirst) {
            fr = root1;
        } else {
            fr = proof[0];
            i = 1;
        }
        bytes32 sr = fr;
        while (fn & 1 == 1) {
            fn >>= 1;
            sn >>= 1;
        }
        for (; i < proof.length; ++i) {
            if (sn == 0) return false;
            bytes32 c = proof[i];
            if (fn & 1 == 1 || fn == sn) {
                fr = hashChildren(c, fr);
                sr = hashChildren(c, sr);
                while (fn & 1 == 0 && fn != 0) {
                    fn >>= 1;
                    sn >>= 1;
                }
            } else {
                sr = hashChildren(sr, c);
            }
            fn >>= 1;
            sn >>= 1;
        }
        return fr == root1 && sr == root2 && sn == 0;
    }

    /// @notice The root the inclusion `proof` of the leaf hash `leafHash` at `index` yields for a tree of `size`
    /// leaves; `ok` is false for `index >= size` or a proof of the wrong length.
    function rootFromInclusion(uint64 index, uint64 size, bytes32 leafHash, bytes32[] calldata proof)
        internal
        view
        returns (bytes32 root, bool ok)
    {
        if (index >= size) return (root, ok);
        uint64 fn = index;
        uint64 sn = size - 1;
        bytes32 r = leafHash;
        for (uint256 i = 0; i < proof.length; ++i) {
            if (sn == 0) return (root, ok);
            bytes32 p = proof[i];
            if (fn & 1 == 1 || fn == sn) {
                r = hashChildren(p, r);
                while (fn & 1 == 0 && fn != 0) {
                    fn >>= 1;
                    sn >>= 1;
                }
            } else {
                r = hashChildren(r, p);
            }
            fn >>= 1;
            sn >>= 1;
        }
        ok = sn == 0;
        if (ok) root = r;
    }
}
