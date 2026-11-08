// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {SymbolicSetup} from "./SymbolicSetup.sol";

/// @notice Bounded symbolic checks of the signer registry's verification.
contract VerdictVerifierSymbolicTest is SymbolicSetup {
    /// @notice SIG1: `verify2of2` accepts arbitrary signature bytes only when the first recovers to the active TDX
    /// signer and the second to the active, distinct Nitro signer, both under allowed measurements; disallowing either
    /// measurement stops it.
    function check_verify2of2(bytes32 digest, bytes calldata sigs) public view {
        if (verifier.verify2of2(digest, sigs)) {
            assert(sigs.length == 130);
            assert(_recover(digest, sigs[0:65]) == tdx && _recover(digest, sigs[65:130]) == nitro && tdx != nitro);
            assert(verifier.allowedMeasurement(TDX_MEASUREMENT) && verifier.allowedMeasurement(NITRO_MEASUREMENT));
        }
    }

    function check_verify2of2Disallowed(bytes32 digest, bool disallowTdx) public {
        verifier.disallowMeasurement(disallowTdx ? TDX_MEASUREMENT : NITRO_MEASUREMENT);
        assert(!verifier.verify2of2(digest, _sign2of2(digest)));
    }
}
