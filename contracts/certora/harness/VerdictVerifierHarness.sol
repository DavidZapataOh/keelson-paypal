// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {VerdictVerifier} from "../../src/VerdictVerifier.sol";
import {IAutomataDcapAttestation} from "../../src/interfaces/IAutomataDcapAttestation.sol";
import {INitroValidator} from "../../src/interfaces/INitroValidator.sol";

contract VerdictVerifierHarness is VerdictVerifier {
    constructor(
        address authority,
        address bondVault,
        bytes32 issuer_,
        bytes32[] memory initialMeasurements,
        IAutomataDcapAttestation dcapAttestation,
        INitroValidator nitroValidator
    ) VerdictVerifier(authority, bondVault, issuer_, initialMeasurements, dcapAttestation, nitroValidator) {}

    function recover(bytes32 digest, bytes calldata sig) external pure returns (address) {
        return _recover(digest, sig);
    }

    function recoverPart(bytes32 digest, bytes calldata sigs, uint256 start) external pure returns (address) {
        return _recover(digest, sigs[start:start + 65]);
    }

    function measurementId(bytes32 measurement) external view returns (uint64) {
        return _measurementIds[measurement];
    }

    function allowedId(uint64 id) external view returns (bool) {
        return _allowed[id];
    }

    function signerMeasurementId(address signer) external view returns (uint64) {
        return _signers[signer].measurementId;
    }
}
