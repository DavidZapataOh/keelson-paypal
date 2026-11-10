// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IAnonymousMandateVerifier, RegisteredUserSet} from "../src/RegisteredUserSet.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The registered-user roots Keelson's relayer publishes, and a C3 proof checked against a published root.
contract RegisteredUserSetTest is Test {
    using stdJson for string;

    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    address internal publisher = makeAddr("publisher");
    address internal guardian = makeAddr("guardian");
    RegisteredUserSet internal users;
    bytes internal proof;
    bytes32[] internal inputs;

    function setUp() public {
        IAnonymousMandateVerifier verifier =
            IAnonymousMandateVerifier(deployCode("AnonymousMandateVerifier.sol:HonkVerifier"));
        AccessManager manager = new AccessManager(address(this));
        users = new RegisteredUserSet(address(manager), verifier);
        bytes4[] memory publish = new bytes4[](1);
        publish[0] = RegisteredUserSet.publish.selector;
        manager.setTargetFunctionRole(address(users), publish, KeelsonRoles.PUBLISHER_ROLE);
        manager.grantRole(KeelsonRoles.PUBLISHER_ROLE, publisher, 0);
        bytes4[] memory revoke = new bytes4[](1);
        revoke[0] = RegisteredUserSet.revoke.selector;
        manager.setTargetFunctionRole(address(users), revoke, KeelsonRoles.GUARDIAN_ROLE);
        manager.grantRole(KeelsonRoles.GUARDIAN_ROLE, guardian, 0);
        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c3-payment.json"));
        proof = v.readBytes(".proof");
        inputs = v.readBytes32Array(".publicInputs");
    }

    function test_publish_recordsTheRootOnce() public {
        vm.warp(1_800_000_000);
        vm.expectEmit(address(users));
        emit RegisteredUserSet.RootPublished(inputs[2], 3);
        vm.prank(publisher);
        users.publish(inputs[2], 3);
        (uint64 publishedAt, uint32 size,) = users.roots(inputs[2]);
        assertEq(publishedAt, 1_800_000_000);
        assertEq(size, 3);
        // Publishing the same root again changes nothing and does not revert, so a retried transaction is harmless.
        vm.warp(1_800_000_100);
        vm.prank(publisher);
        users.publish(inputs[2], 4);
        (publishedAt, size,) = users.roots(inputs[2]);
        assertEq(publishedAt, 1_800_000_000);
        assertEq(size, 3);
    }

    function test_gas_publish() public {
        vm.prank(publisher);
        users.publish(inputs[2], 3);
        GasBudget.check("userSet_publish", vm.lastCallGas().gasTotalUsed);
    }

    function test_RevertWhen_NotThePublisher() public {
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, address(this)));
        users.publish(inputs[2], 3);
    }

    function test_RevertWhen_TheRootIsEmpty() public {
        vm.prank(publisher);
        vm.expectRevert(RegisteredUserSet.InvalidRoot.selector);
        users.publish(bytes32(0), 3);
        vm.prank(publisher);
        vm.expectRevert(RegisteredUserSet.InvalidRoot.selector);
        users.publish(bytes32(R), 3);
        vm.prank(publisher);
        vm.expectRevert(RegisteredUserSet.InvalidRoot.selector);
        users.publish(inputs[2], 0);
        vm.prank(publisher);
        vm.expectRevert(RegisteredUserSet.InvalidRoot.selector);
        users.publish(inputs[2], uint32(1 << 20) + 1);
    }

    function test_revoke_endsTheRoot() public {
        vm.prank(publisher);
        users.publish(inputs[2], 3);
        vm.warp(1_800_000_000);
        vm.expectEmit(address(users));
        emit RegisteredUserSet.RootRevoked(inputs[2]);
        vm.prank(guardian);
        users.revoke(inputs[2]);
        (, uint32 size, uint64 revokedAt) = users.roots(inputs[2]);
        assertEq(size, 3);
        assertEq(revokedAt, 1_800_000_000);
        assertFalse(users.verify(proof, inputs[0], inputs[1], inputs[2]));
        // A revoked root is never published again.
        vm.prank(publisher);
        users.publish(inputs[2], 3);
        assertFalse(users.verify(proof, inputs[0], inputs[1], inputs[2]));
        vm.warp(1_800_000_100);
        vm.prank(guardian);
        users.revoke(inputs[2]);
        (,, revokedAt) = users.roots(inputs[2]);
        assertEq(revokedAt, 1_800_000_000);
    }

    function test_RevertWhen_RevokingAsSomeoneElseOrAnUnknownRoot() public {
        vm.prank(publisher);
        users.publish(inputs[2], 3);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, publisher));
        users.revoke(inputs[2]);
        vm.prank(guardian);
        vm.expectRevert(RegisteredUserSet.UnknownRoot.selector);
        users.revoke(bytes32(uint256(inputs[2]) + 1));
    }

    function test_verify_returnsFalseForAProofTheVerifierRejects() public {
        vm.prank(publisher);
        users.publish(inputs[2], 3);
        bytes memory bad = bytes.concat(proof);
        bad[100] = bad[100] ^ 0x01;
        assertFalse(users.verify(bad, inputs[0], inputs[1], inputs[2]));
        bytes memory short = new bytes(proof.length - 32);
        for (uint256 i; i < short.length; ++i) {
            short[i] = proof[i];
        }
        assertFalse(users.verify(short, inputs[0], inputs[1], inputs[2]));
        // A commitment past the field is refused, not reduced.
        assertFalse(users.verify(proof, bytes32(uint256(inputs[0]) + R), inputs[1], inputs[2]));
    }

    function testFuzz_publish_neverChangesAPublishedRoot(uint32 size, uint64 later) public {
        size = uint32(bound(size, 1, 1 << 20));
        vm.prank(publisher);
        users.publish(inputs[2], 3);
        (uint64 first,,) = users.roots(inputs[2]);
        vm.warp(block.timestamp + bound(later, 0, 365 days));
        vm.prank(publisher);
        users.publish(inputs[2], size);
        (uint64 at2, uint32 size2,) = users.roots(inputs[2]);
        assertEq(at2, first);
        assertEq(size2, 3);
    }

    /// @dev The demo vector's challenge M is below the field modulus: any word congruent to it is the same input.
    function test_verify_acceptsAProofUnderAPublishedRoot() public {
        vm.prank(publisher);
        users.publish(inputs[2], 3);
        assertTrue(users.verify(proof, inputs[0], inputs[1], inputs[2]));
        assertTrue(users.verify(proof, inputs[0], bytes32(uint256(inputs[1]) + R), inputs[2]));
    }

    function test_gas_verify() public {
        vm.prank(publisher);
        users.publish(inputs[2], 3);
        assertTrue(users.verify(proof, inputs[0], inputs[1], inputs[2]));
        GasBudget.check("userSet_verify", vm.lastCallGas().gasTotalUsed);
    }

    function test_verify_refusesAnUnpublishedRoot() public view {
        assertFalse(users.verify(proof, inputs[0], inputs[1], inputs[2]));
    }

    function test_verify_refusesAnotherMandate() public {
        vm.prank(publisher);
        users.publish(inputs[2], 3);
        assertFalse(users.verify(proof, inputs[0], bytes32(uint256(inputs[1]) + 1), inputs[2]));
        assertFalse(users.verify(proof, bytes32(uint256(inputs[0]) + 1), inputs[1], inputs[2]));
    }

    function test_verify_refusesAnotherPublishedRoot() public {
        bytes32 other = bytes32(uint256(inputs[2]) + 1);
        vm.prank(publisher);
        users.publish(other, 4);
        assertFalse(users.verify(proof, inputs[0], inputs[1], other));
    }
}
