// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Sha384} from "../src/libraries/Sha384.sol";
import {Test} from "forge-std/Test.sol";

/// @notice NIST CAVP "SHA Test Vectors for Hashing Byte-Oriented Messages", SHA-384 ShortMsg and LongMsg.
contract Sha384Test is Test {
    /// @dev Element by element: `vm.parseJson` would decode the empty message `0x` as a string.
    function _check(string memory key) internal view returns (uint256 count) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/sha384-cavp.json"));
        for (;; ++count) {
            string memory path = string.concat(key, "[", vm.toString(count), "]");
            if (!vm.keyExistsJson(json, path)) break;
            bytes memory message = vm.parseJsonBytes(json, string.concat(path, ".msg"));
            assertEq(Sha384.hash(message), vm.parseJsonBytes(json, string.concat(path, ".md")), path);
        }
    }

    function test_ShortMsg() public view {
        assertEq(_check(".short"), 129);
    }

    function test_LongMsg() public view {
        assertEq(_check(".long"), 128);
    }

    /// @dev The padding boundaries: 111 bytes fit one final block, 112 need two.
    function test_PaddingBoundaries() public pure {
        assertEq(
            Sha384.hash(new bytes(111)),
            hex"435770712c611be7293a66dd0dc8d1450dc7ff7337bfe115bf058ef2eb9bed09cee85c26963a5bcc0905dc2df7cc6a76"
        );
        assertEq(
            Sha384.hash(new bytes(112)),
            hex"3e0cbf3aee0e3aa70415beae1bd12dd7db821efa446440f12132edffce76f635e53526a111491e75ee8e27b9700eec20"
        );
    }

    /// @dev Gas of one 128-byte block: the 111-byte message pads to one block.
    function test_GasPerBlock() public {
        bytes memory one = new bytes(111);
        uint256 before = gasleft();
        Sha384.hash(one);
        uint256 used = before - gasleft();
        emit log_named_uint("sha384 gas, one block", used);
        bytes memory nine = new bytes(1135);
        before = gasleft();
        Sha384.hash(nine);
        emit log_named_uint("sha384 gas per block, marginal", (before - gasleft() - used) / 8);
    }
}
