// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ISP1Verifier} from "@sp1-contracts/ISP1Verifier.sol";

/// @title EngineProofVerifier
/// @notice Records SP1 proofs that the Keelson engine's canonicalizer and Cedar evaluation, run again in the SP1 zkVM
/// over a countersign's stored inputs, give the `evalHash` the TEE legs signed. A proof's public values are
/// `abi.encode(evalHash, countersignDigest)`, the digest being the EIP-712 `Countersign` signing hash, so a dispute
/// reads `proven(digest)` and compares it with the countersign's own `evalHash`. Permissionless, immutable, no admin.
contract EngineProofVerifier {
    /// @notice The SP1 verifier gateway, which routes a proof to the verifier of its SP1 version.
    ISP1Verifier public immutable VERIFIER;
    /// @notice The verifying key of the engine's SP1 program.
    bytes32 public immutable PROGRAM_VKEY;

    /// @notice The `evalHash` proven for a countersign digest, zero when none is.
    mapping(bytes32 countersignDigest => bytes32 evalHash) public proven;

    event EngineProven(bytes32 indexed countersignDigest, bytes32 evalHash, address indexed prover);

    error AlreadyProven(bytes32 countersignDigest);
    error InvalidPublicValues();

    constructor(ISP1Verifier verifier, bytes32 programVKey) {
        VERIFIER = verifier;
        PROGRAM_VKEY = programVKey;
    }

    /// @notice Reverts unless `proof` is a proof of the engine program with `publicValues`.
    function verify(bytes calldata publicValues, bytes calldata proof)
        public
        view
        returns (bytes32 evalHash, bytes32 countersignDigest)
    {
        if (publicValues.length != 64) revert InvalidPublicValues();
        VERIFIER.verifyProof(PROGRAM_VKEY, publicValues, proof);
        (evalHash, countersignDigest) = abi.decode(publicValues, (bytes32, bytes32));
    }

    /// @notice Verifies `proof` and records its `evalHash` for its countersign digest, once.
    function record(bytes calldata publicValues, bytes calldata proof)
        external
        returns (bytes32 evalHash, bytes32 countersignDigest)
    {
        (evalHash, countersignDigest) = verify(publicValues, proof);
        if (proven[countersignDigest] != 0) revert AlreadyProven(countersignDigest);
        proven[countersignDigest] = evalHash;
        emit EngineProven(countersignDigest, evalHash, msg.sender);
    }
}
