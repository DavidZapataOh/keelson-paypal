// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";

/// @title PasskeyAssertion
/// @notice Verifies a user's passkey assertion over a mandate challenge: a WebAuthn assertion (`webauthn.get`) or a
/// Secure Payment Confirmation one (`payment.get`), signed with P-256 and checked by the RIP-7212 precompile.
/// @dev OpenZeppelin `WebAuthn.verify` over calldata, with steps 11–20 of W3C WebAuthn L3 §7.2, plus two changes: the
/// type may be `payment.get` (W3C Secure Payment Confirmation, "verifying an authentication assertion"), and the
/// authenticator data must name the expected RP ID hash. As in OpenZeppelin, `s` must be in the lower half of the
/// order: encoders replace a high `s` by `N - s`.
library PasskeyAssertion {
    struct Assertion {
        bytes32 r;
        bytes32 s;
        /// @notice Byte offset of `"challenge":"` in `clientDataJSON`.
        uint256 challengeIndex;
        /// @notice Byte offset of `"type":"` in `clientDataJSON`.
        uint256 typeIndex;
        bytes authenticatorData;
        string clientDataJSON;
    }

    bytes1 private constant FLAG_UP = 0x01;
    bytes1 private constant FLAG_UV = 0x04;
    bytes1 private constant FLAG_BE = 0x08;
    bytes1 private constant FLAG_BS = 0x10;

    /// @notice Whether `a` is a user-verified assertion over `challenge` by the key `(qx, qy)` for `rpIdHash`.
    function verify(bytes32 challenge, Assertion calldata a, bytes32 rpIdHash, bytes32 qx, bytes32 qy)
        internal
        view
        returns (bool)
    {
        bytes calldata authenticatorData = a.authenticatorData;
        // rpIdHash (32) ‖ flags (1) ‖ signCount (4)
        if (authenticatorData.length < 37 || bytes32(authenticatorData[:32]) != rpIdHash) return false;
        bytes1 flags = authenticatorData[32];
        if (flags & FLAG_UP == 0 || flags & FLAG_UV == 0) return false;
        if (flags & FLAG_BE == 0 && flags & FLAG_BS != 0) return false;

        bytes calldata clientDataJSON = bytes(a.clientDataJSON);
        if (!_hasType(clientDataJSON, a.typeIndex) || !_hasChallenge(clientDataJSON, a.challengeIndex, challenge)) {
            return false;
        }
        return P256.verifyNative(sha256(abi.encodePacked(authenticatorData, sha256(clientDataJSON))), a.r, a.s, qx, qy);
    }

    /// @notice `M = SHA-256("keelson/mandate-challenge/v1" ‖ 0x00 ‖ H_sd ‖ C_m)`, the challenge the user's passkey signs.
    function mandateChallenge(bytes32 hSd, bytes32 cm) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("keelson/mandate-challenge/v1", bytes1(0x00), hSd, cm));
    }

    function _hasType(bytes calldata json, uint256 i) private pure returns (bool) {
        if (i >= json.length) return false;
        uint256 left = json.length - i;
        // forge-lint: disable-start(unsafe-typecast)
        return (left >= 21 && bytes21(json[i:i + 21]) == bytes21('"type":"webauthn.get"'))
            || (left >= 20 && bytes20(json[i:i + 20]) == bytes20('"type":"payment.get"'));
        // forge-lint: disable-end(unsafe-typecast)
    }

    function _hasChallenge(bytes calldata json, uint256 i, bytes32 challenge) private pure returns (bool) {
        bytes memory expected = abi.encodePacked('"challenge":"', Base64.encodeURL(abi.encodePacked(challenge)), '"');
        if (i >= json.length || json.length - i < expected.length) return false;
        return keccak256(json[i:i + expected.length]) == keccak256(expected);
    }
}
