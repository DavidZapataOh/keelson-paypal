// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonBondVault} from "../../src/KeelsonBondVault.sol";
import {ICheckpointAnchor} from "../../src/interfaces/ICheckpointAnchor.sol";
import {IERC8004Identity} from "../../src/interfaces/IERC8004Identity.sol";
import {IPYUSD} from "../../src/interfaces/IPYUSD.sol";
import {IVerdictVerifier} from "../../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";

contract KeelsonBondVaultHarness is KeelsonBondVault {
    constructor(
        IPYUSD pyusd_,
        IVerdictVerifier verifier_,
        ICheckpointAnchor anchor_,
        IERC8004Identity identity_,
        address reserve_,
        bytes32 logOrigin_,
        bytes32 rpIdHash_,
        address authority,
        Params memory params_,
        uint48 rateLimitWindow,
        uint208 rateLimitCapacity
    )
        KeelsonBondVault(
            pyusd_,
            verifier_,
            anchor_,
            identity_,
            reserve_,
            logOrigin_,
            rpIdHash_,
            authority,
            params_,
            rateLimitWindow,
            rateLimitCapacity
        )
    {}

    function reentrancyGuardEntered() external view returns (bool) {
        return _reentrancyGuardEntered();
    }

    function verdictStructHash(KeelsonTypes.Verdict calldata v) external pure returns (bytes32) {
        return KeelsonTypes.hash(v);
    }

    function countersignStructHash(KeelsonTypes.Countersign calldata c) external pure returns (bytes32) {
        return KeelsonTypes.hash(c);
    }
}
