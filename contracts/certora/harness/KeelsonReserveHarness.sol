// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonReserve} from "../../src/KeelsonReserve.sol";
import {ICheckpointAnchor} from "../../src/interfaces/ICheckpointAnchor.sol";
import {IKeelsonBondVault} from "../../src/interfaces/IKeelsonBondVault.sol";
import {IVerdictVerifier} from "../../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract KeelsonReserveHarness is KeelsonReserve {
    constructor(
        IERC20 pyusd,
        IVerdictVerifier verifier_,
        ICheckpointAnchor anchor_,
        IKeelsonBondVault vault_,
        bytes32 logOrigin_,
        address authority,
        uint40 cooldown_,
        uint48 rateLimitWindow,
        uint208 rateLimitCapacity
    )
        KeelsonReserve(
            pyusd,
            verifier_,
            anchor_,
            vault_,
            logOrigin_,
            authority,
            cooldown_,
            rateLimitWindow,
            rateLimitCapacity
        )
    {}

    function claimableShares(address controller) external view returns (uint256) {
        return _redemptions[controller].claimableShares;
    }

    function verdictStructHash(KeelsonTypes.Verdict calldata v) external pure returns (bytes32) {
        return KeelsonTypes.hash(v);
    }
}
