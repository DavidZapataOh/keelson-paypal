// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CheckpointAnchor} from "../../src/CheckpointAnchor.sol";
import {IVerdictVerifier} from "../../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";

contract CheckpointAnchorHarness is CheckpointAnchor {
    constructor(IVerdictVerifier verifier_) CheckpointAnchor(verifier_) {}

    function latestSize(bytes32 origin) external view returns (uint64) {
        return _latest[origin].size;
    }

    function checkpointStructHash(bytes32 origin, uint64 size, bytes32 root) external pure returns (bytes32) {
        return KeelsonTypes.hash(KeelsonTypes.Checkpoint({origin: origin, treeSize: size, rootHash: root}));
    }
}
