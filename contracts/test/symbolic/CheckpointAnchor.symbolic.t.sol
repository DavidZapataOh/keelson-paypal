// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {RFC6962} from "../../src/libraries/RFC6962.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Calls the library the anchor verifies consistency with, which takes the proof as calldata.
contract ConsistencyVerifier {
    function verify(uint64 size1, uint64 size2, bytes32 root1, bytes32 root2, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        return RFC6962.verifyConsistency(size1, size2, root1, root2, proof);
    }
}

/// @notice ANC3, bounded: for every pair of tree sizes up to 16 and arbitrary leaves, the anchor's consistency check
/// accepts the RFC 6962 proof between the two trees and rejects it against any other new root.
/// @dev The reference tree hash and proof follow RFC 6962 §2.1 (MTH and SUBPROOF) recursively, independently of the
/// library's iterative verifier.
contract CheckpointAnchorSymbolicTest is Test {
    uint256 internal constant MAX_SIZE = 16;

    ConsistencyVerifier internal consistency;
    bytes32[MAX_SIZE] internal leaves;

    function setUp() public {
        consistency = new ConsistencyVerifier();
    }

    /// forge-config: default.symbolic.max_depth = 10000000
    /// forge-config: default.symbolic.max_solver_queries = 1000000
    function check_rfc6962Consistency(bytes32[MAX_SIZE] calldata leafHashes, bytes32 otherRoot) public {
        leaves = leafHashes;
        for (uint256 n = 2; n <= MAX_SIZE; ++n) {
            bytes32 root2 = _mth(0, n);
            vm.assume(otherRoot != root2);
            for (uint256 m = 1; m < n; ++m) {
                bytes32 root1 = _mth(0, m);
                bytes32[] memory proof = _subproof(m, 0, n, true);
                assert(consistency.verify(uint64(m), uint64(n), root1, root2, proof));
                assert(!consistency.verify(uint64(m), uint64(n), root1, otherRoot, proof));
            }
        }
    }

    /// @dev MTH(D[start:start+n]); leaves stand for their leaf hashes.
    function _mth(uint256 start, uint256 n) internal view returns (bytes32) {
        if (n == 1) return leaves[start];
        uint256 k = _split(n);
        return _node(_mth(start, k), _mth(start + k, n - k));
    }

    /// @dev SUBPROOF(m, D[start:start+n], b).
    function _subproof(uint256 m, uint256 start, uint256 n, bool b) internal view returns (bytes32[] memory) {
        if (m == n) {
            if (b) return new bytes32[](0);
            bytes32[] memory one = new bytes32[](1);
            one[0] = _mth(start, n);
            return one;
        }
        uint256 k = _split(n);
        if (m <= k) return _append(_subproof(m, start, k, b), _mth(start + k, n - k));
        return _append(_subproof(m - k, start + k, n - k, false), _mth(start, k));
    }

    /// @dev The largest power of two smaller than `n`.
    function _split(uint256 n) internal pure returns (uint256 k) {
        k = 1;
        while (k << 1 < n) {
            k <<= 1;
        }
    }

    function _node(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes1(0x01), l, r));
    }

    function _append(bytes32[] memory a, bytes32 x) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](a.length + 1);
        for (uint256 i; i < a.length; ++i) {
            out[i] = a[i];
        }
        out[a.length] = x;
    }
}
