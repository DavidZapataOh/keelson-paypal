// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ed25519Verifier} from "../src/verifiers/Ed25519Verifier.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

/// @notice RFC 8032 §7.1 and the 1,024 vectors of Bernstein et al.'s `sign.input`, valid and tampered.
contract Ed25519VerifierTest is Test {
    using stdJson for string;

    /// @dev The Ed25519 group order L.
    uint256 internal constant L = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed;

    Ed25519Verifier internal ed;

    function setUp() public {
        ed = new Ed25519Verifier();
    }

    function _sig(bytes32 r, bytes32 s) internal pure returns (bytes memory) {
        return abi.encodePacked(r, s);
    }

    function test_rfc8032Test1() public view {
        bytes32 key = 0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a;
        bytes memory sig = _sig(
            0xe5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155,
            0x5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b
        );
        assertTrue(ed.verify(key, "", sig));
        assertFalse(ed.verify(key, hex"00", sig));
    }

    function test_rfc8032Test2() public view {
        bytes32 key = 0x3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c;
        bytes memory sig = _sig(
            0x92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da,
            0x085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00
        );
        assertTrue(ed.verify(key, hex"72", sig));
        assertFalse(ed.verify(key, hex"73", sig));
    }

    /// @dev Vectors `[from, to)` of the file; eight tests keep each under the default gas limit.
    function _signInput(uint256 from, uint256 to) internal view {
        string memory file = string.concat(vm.projectRoot(), "/lib/crypto-lib/test/utils/ed25519tv.json");
        for (uint256 i; i < to; ++i) {
            string memory line = vm.readLine(file);
            if (i < from) continue;
            bytes32 key = line.readBytes32(".kpub");
            bytes memory message = line.readBytes(".msg");
            bytes memory sig = _sig(line.readBytes32(".r"), line.readBytes32(".s"));
            assertTrue(ed.verify(key, message, sig), "valid");
            sig[20] ^= 0x08;
            assertFalse(ed.verify(key, message, sig), "tampered R");
        }
    }

    function test_signInput0() public view {
        _signInput(0, 128);
    }

    function test_signInput1() public view {
        _signInput(128, 256);
    }

    function test_signInput2() public view {
        _signInput(256, 384);
    }

    function test_signInput3() public view {
        _signInput(384, 512);
    }

    function test_signInput4() public view {
        _signInput(512, 640);
    }

    function test_signInput5() public view {
        _signInput(640, 768);
    }

    function test_signInput6() public view {
        _signInput(768, 896);
    }

    function test_signInput7() public view {
        _signInput(896, 1024);
    }

    function test_refusesAnotherKeyOrMessage() public view {
        bytes32 key = 0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a;
        bytes32 other = 0x3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c;
        bytes memory sig = _sig(
            0xe5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155,
            0x5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b
        );
        assertFalse(ed.verify(other, "", sig));
        assertFalse(ed.verify(key, "", abi.encodePacked(sig, bytes1(0))));
        assertFalse(ed.verify(key, "", new bytes(63)));
    }

    /// @dev S + L is the same signature to a verifier that reduces S; RFC 8032 requires S < L.
    function test_refusesANonCanonicalS() public view {
        bytes32 key = 0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a;
        bytes32 r = 0xe5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155;
        uint256 s = _le(0x5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b);
        assertFalse(ed.verify(key, "", _sig(r, bytes32(_le(bytes32(s + L))))));
    }

    /// @dev y = 2 has no x on the curve; y = 1 is the identity.
    function test_refusesKeysThatAreNotUsablePoints() public view {
        bytes memory sig = new bytes(64);
        assertFalse(ed.verify(bytes32(uint256(2) << 248), "", sig));
        assertFalse(ed.verify(bytes32(uint256(1) << 248), "", sig));
        assertFalse(ed.verify(bytes32(type(uint256).max), "", sig));
    }

    function _le(bytes32 v) internal pure returns (uint256 r) {
        for (uint256 i; i < 32; ++i) {
            r |= uint256(uint8(v[i])) << (8 * i);
        }
    }
}
