// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title IAutomataDcapAttestation
/// @notice The entrypoints of Automata's `AutomataDcapAttestationFee` (automata-dcap-attestation v1.2.0) that verify an
/// Intel DCAP quote, fully on-chain or from a zkVM proof of the same verification.
/// @dev On success `output` is Automata's serialized `Output`: `uint16 quoteVersion ‖ uint16 quoteBodyType ‖
/// uint8 tcbStatus ‖ bytes6 fmspc ‖ quoteBody ‖ abi.encode(string[] advisoryIDs)`, the last part only when there are
/// advisories. On failure `success` is false and `output` is the UTF-8 reason.
interface IAutomataDcapAttestation {
    function verifyAndAttestOnChain(bytes calldata rawQuote)
        external
        payable
        returns (bool success, bytes memory output);

    /// @param zkCoprocessor Automata's `ZkCoProcessorType`: 1 RISC Zero, 2 SP1, 3 Pico.
    function verifyAndAttestWithZKProof(bytes calldata output, uint8 zkCoprocessor, bytes calldata proofBytes)
        external
        payable
        returns (bool success, bytes memory verifiedOutput);
}
