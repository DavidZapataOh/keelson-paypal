// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {RFC6962} from "../src/libraries/RFC6962.sol";
import {Test} from "forge-std/Test.sol";

/// @dev Exposes the library over calldata proofs.
contract RFC6962Harness {
    function verifyConsistency(uint64 size1, uint64 size2, bytes32 root1, bytes32 root2, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        return RFC6962.verifyConsistency(size1, size2, root1, root2, proof);
    }

    function rootFromInclusion(uint64 index, uint64 size, bytes32 leafHash, bytes32[] calldata proof)
        external
        view
        returns (bytes32, bool)
    {
        return RFC6962.rootFromInclusion(index, size, leafHash, proof);
    }

    function hashChildren(bytes32 l, bytes32 r) external view returns (bytes32) {
        return RFC6962.hashChildren(l, r);
    }
}

/// @notice Every consistency pair and inclusion proof of the conformance tree up to 64 leaves, their negative twins,
/// and real proofs of the sandbox log, all checked against transparency-dev/merkle by `vectors/gen`.
contract RFC6962Test is Test {
    /// @dev Fields in the alphabetical order `vm.parseJson` decodes them in.
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

    RFC6962Harness internal lib;

    function setUp() public {
        lib = new RFC6962Harness();
    }

    /// @dev Read in each test: the file is too large to keep in storage.
    function _json() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/rfc6962.json"));
    }

    function _consistency(string memory json, string memory key) internal pure returns (Consistency[] memory) {
        return abi.decode(vm.parseJson(json, key), (Consistency[]));
    }

    function _inclusion(string memory json, string memory key) internal pure returns (Inclusion[] memory) {
        return abi.decode(vm.parseJson(json, key), (Inclusion[]));
    }

    function _check(Consistency memory v) internal view returns (bool) {
        return lib.verifyConsistency(uint64(v.size1), uint64(v.size2), v.root1, v.root2, v.proof);
    }

    function _check(Inclusion memory v) internal view returns (bool) {
        (bytes32 root, bool ok) = lib.rootFromInclusion(uint64(v.index), uint64(v.size), v.leafHash, v.proof);
        return ok && root == v.root;
    }

    function test_consistencyVectors() public view {
        Consistency[] memory c = _consistency(_json(), ".consistency");
        assertEq(c.length, 4160);
        for (uint256 i; i < c.length; ++i) {
            assertEq(_check(c[i]), c[i].ok, string.concat("consistency ", vm.toString(i)));
        }
    }

    function test_inclusionVectors() public view {
        Inclusion[] memory n = _inclusion(_json(), ".inclusion");
        assertEq(n.length, 4160);
        for (uint256 i; i < n.length; ++i) {
            assertEq(_check(n[i]), n[i].ok, string.concat("inclusion ", vm.toString(i)));
        }
    }

    struct StatementLeaf {
        uint256 index;
        bytes leaf;
        bytes32 leafHash;
        bytes32[] proof;
    }

    /// @notice A log mixing v1 JCS leaves with SCITT statement leaves (purchase, card, bridge): the
    /// leaf hash of a CBOR statement is the same RFC 6962 hash, and every leaf proves into the root.
    function test_statementLeafInclusion() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/statement-inclusion.json"));
        bytes32 root = vm.parseJsonBytes32(json, ".root");
        uint64 size = uint64(vm.parseJsonUint(json, ".size"));
        StatementLeaf[] memory leaves = abi.decode(vm.parseJson(json, ".leaves"), (StatementLeaf[]));
        assertEq(leaves.length, uint256(size));
        uint256 statements;
        for (uint256 i; i < leaves.length; ++i) {
            StatementLeaf memory l = leaves[i];
            assertEq(sha256(abi.encodePacked(bytes1(0), l.leaf)), l.leafHash, "leaf hash");
            (bytes32 r, bool ok) = lib.rootFromInclusion(uint64(l.index), size, l.leafHash, l.proof);
            assertTrue(ok && r == root, "inclusion");
            bytes32[] memory bad = l.proof;
            bad[0] ^= bytes32(uint256(1));
            (r, ok) = lib.rootFromInclusion(uint64(l.index), size, l.leafHash, bad);
            assertFalse(ok && r == root, "flipped path");
            if (l.leaf[0] == 0xd2) ++statements;
        }
        assertEq(statements, 6);
    }

    function test_sandboxVectors() public view {
        string memory json = _json();
        Consistency[] memory c = _consistency(json, ".sandboxConsistency");
        Inclusion[] memory n = _inclusion(json, ".sandboxInclusion");
        assertEq(c.length, 2);
        assertEq(n.length, 3);
        for (uint256 i; i < c.length; ++i) {
            assertTrue(_check(c[i]));
        }
        for (uint256 i; i < n.length; ++i) {
            assertTrue(_check(n[i]));
        }
    }

    function test_twentyNodeProofs() public view {
        string memory json = _json();
        Consistency memory c = abi.decode(vm.parseJson(json, ".gasConsistency"), (Consistency));
        Inclusion memory n = abi.decode(vm.parseJson(json, ".gasInclusion"), (Inclusion));
        assertEq(c.proof.length, 20);
        assertEq(n.proof.length, 20);
        assertTrue(_check(c));
        assertTrue(_check(n));
    }

    /// forge-config: default.fuzz.seed = "0x6962"
    /// forge-config: ci.fuzz.seed = "0x6962"
    function testFuzz_consistencyRejectsAnyFlippedNode(uint256 vec, uint256 node, uint8 bit) public view {
        Consistency[] memory all = _consistency(_json(), ".consistency");
        // Positive vectors sit at even indexes, each followed by its negative twin.
        Consistency memory v = all[2 * bound(vec, 0, all.length / 2 - 1)];
        assertTrue(v.ok);
        vm.assume(v.proof.length > 0);
        uint256 k = bound(node, 0, v.proof.length - 1);
        v.proof[k] ^= bytes32(uint256(1) << bit);
        assertFalse(_check(v));
    }

    function test_emptyTreeIsNotAnAnchorSource() public view {
        bytes32[] memory none = new bytes32[](0);
        Consistency memory v = abi.decode(vm.parseJson(_json(), ".gasConsistency"), (Consistency));
        assertFalse(lib.verifyConsistency(0, uint64(v.size2), bytes32(0), v.root2, v.proof));
        assertFalse(lib.verifyConsistency(0, 0, bytes32(0), bytes32(0), none));
        assertFalse(lib.verifyConsistency(2, 1, v.root2, v.root2, none));
    }

    function test_hashChildrenIsTheRfc6962Node() public view {
        bytes32 l = keccak256("l");
        bytes32 r = keccak256("r");
        assertEq(lib.hashChildren(l, r), sha256(abi.encodePacked(bytes1(0x01), l, r)));
    }
}
