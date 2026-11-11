// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title IEd25519Verifier
/// @notice Ed25519 signature verification (RFC 8032 §5.1.7), which the EVM has no precompile for.
interface IEd25519Verifier {
    /// @notice Whether `signature` (`R ‖ S`, 64 bytes as RFC 8032 encodes them) is `key`'s signature of `message`.
    /// @param key The 32-byte public key as RFC 8032 encodes it.
    function verify(bytes32 key, bytes calldata message, bytes calldata signature) external view returns (bool);
}
