// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonValidationRegistry} from "../../src/KeelsonValidationRegistry.sol";
import {IERC8004Identity} from "../../src/interfaces/IERC8004Identity.sol";
import {IKeelsonBondVault} from "../../src/interfaces/IKeelsonBondVault.sol";
import {IVerdictVerifier} from "../../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";

contract KeelsonValidationRegistryHarness is KeelsonValidationRegistry {
    constructor(IERC8004Identity identity_, IVerdictVerifier verifier_, IKeelsonBondVault vault_)
        KeelsonValidationRegistry(identity_, verifier_, vault_)
    {}

    function validatorOf(bytes32 requestHash) external view returns (address) {
        return _validations[requestHash].validatorAddress;
    }

    function agentOf(bytes32 requestHash) external view returns (uint256) {
        return _validations[requestHash].agentId;
    }

    function responseHashOf(bytes32 requestHash) external view returns (bytes32) {
        return _validations[requestHash].responseHash;
    }

    function countersignStructHash(KeelsonTypes.Countersign calldata c) external pure returns (bytes32) {
        return KeelsonTypes.hash(c);
    }
}
