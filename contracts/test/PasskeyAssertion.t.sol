// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {PasskeyAssertion} from "../src/libraries/PasskeyAssertion.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

contract PasskeyAssertionHarness {
    function verify(bytes32 challenge, PasskeyAssertion.Assertion calldata a, bytes32 rpIdHash, bytes32 qx, bytes32 qy)
        external
        view
        returns (bool)
    {
        return PasskeyAssertion.verify(challenge, a, rpIdHash, qx, qy);
    }

    function mandateChallenge(bytes32 hSd, bytes32 cm) external pure returns (bytes32) {
        return PasskeyAssertion.mandateChallenge(hSd, cm);
    }
}

/// @notice Real passkey assertions from Chromium (`vectors/passkey-assertions.json`, generated from
/// `packages/mandate/test/vectors/webauthn.json`): the cases the chain accepts and every way it must refuse one.
/// @dev Osaka gives the local EVM the P256VERIFY precompile at 0x100, as on Arbitrum.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract PasskeyAssertionTest is Test {
    using stdJson for string;

    PasskeyAssertionHarness internal harness;
    string internal vectors;

    function setUp() public {
        harness = new PasskeyAssertionHarness();
        vectors = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/passkey-assertions.json"));
    }

    function _assertion(string memory c) internal view returns (PasskeyAssertion.Assertion memory a) {
        string memory p = string.concat(c, ".assertion");
        a.r = vectors.readBytes32(string.concat(p, ".r"));
        a.s = vectors.readBytes32(string.concat(p, ".s"));
        a.challengeIndex = vectors.readUint(string.concat(p, ".challengeIndex"));
        a.typeIndex = vectors.readUint(string.concat(p, ".typeIndex"));
        a.authenticatorData = vectors.readBytes(string.concat(p, ".authenticatorData"));
        a.clientDataJSON = vectors.readString(string.concat(p, ".clientDataJSON"));
    }

    function _verify(string memory c) internal view returns (bool) {
        return harness.verify(
            vectors.readBytes32(string.concat(c, ".challenge")),
            _assertion(c),
            vectors.readBytes32(string.concat(c, ".rpIdHash")),
            vectors.readBytes32(string.concat(c, ".qx")),
            vectors.readBytes32(string.concat(c, ".qy"))
        );
    }

    function _find(string memory name) internal view returns (string memory c) {
        for (uint256 i;; ++i) {
            c = string.concat(".cases[", vm.toString(i), "]");
            if (keccak256(bytes(vectors.readString(string.concat(c, ".name")))) == keccak256(bytes(name))) return c;
        }
    }

    function test_Vectors() public view {
        uint256 i;
        for (;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(vectors, c)) break;
            assertEq(
                _verify(c),
                vectors.readBool(string.concat(c, ".expected")),
                vectors.readString(string.concat(c, ".name"))
            );
        }
        assertEq(i, 13);
    }

    function test_MandateChallengeOfTheVectors() public view {
        for (uint256 i;; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            if (!vm.keyExistsJson(vectors, c)) break;
            assertEq(
                harness.mandateChallenge(
                    vectors.readBytes32(string.concat(c, ".hSd")), vectors.readBytes32(string.concat(c, ".cm"))
                ),
                vectors.readBytes32(string.concat(c, ".challenge"))
            );
        }
    }

    function test_MandateChallengeOfTheMandatePackage() public view {
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/../packages/mandate/test/vectors/challenge.json"));
        uint256 checked;
        for (uint256 i;; ++i) {
            string memory c = string.concat("[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, c)) break;
            if (keccak256(bytes(json.readString(string.concat(c, ".input.op")))) != keccak256("mandateChallenge")) {
                continue;
            }
            assertEq(
                harness.mandateChallenge(
                    json.readBytes32(string.concat(c, ".input.hSd")), json.readBytes32(string.concat(c, ".input.cm"))
                ),
                json.readBytes32(string.concat(c, ".expected"))
            );
            ++checked;
        }
        assertEq(checked, 4);
    }

    function test_RefusesOutOfRangeIndexes() public view {
        string memory c = _find("ok/webauthn.get");
        PasskeyAssertion.Assertion memory a = _assertion(c);
        bytes32 challenge = vectors.readBytes32(string.concat(c, ".challenge"));
        bytes32 rpIdHash = vectors.readBytes32(string.concat(c, ".rpIdHash"));
        bytes32 qx = vectors.readBytes32(string.concat(c, ".qx"));
        bytes32 qy = vectors.readBytes32(string.concat(c, ".qy"));
        a.typeIndex = type(uint256).max;
        assertFalse(harness.verify(challenge, a, rpIdHash, qx, qy));
        a = _assertion(c);
        a.challengeIndex = bytes(a.clientDataJSON).length - 10;
        assertFalse(harness.verify(challenge, a, rpIdHash, qx, qy));
        a.challengeIndex = type(uint256).max;
        assertFalse(harness.verify(challenge, a, rpIdHash, qx, qy));
    }

    function test_Gas_WebAuthn() public {
        string memory c = _find("ok/webauthn.get");
        assertTrue(_verify(c));
        emit log_named_uint("verify, webauthn.get capture", vm.lastCallGas().gasTotalUsed);
    }

    function test_Gas_Payment() public {
        string memory c = _find("ok/payment.get");
        assertTrue(_verify(c));
        emit log_named_uint("verify, payment.get capture", vm.lastCallGas().gasTotalUsed);
    }
}
