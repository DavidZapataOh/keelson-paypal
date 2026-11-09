// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {GasBudget} from "./utils/GasBudget.sol";
import {VerifierBase} from "./utils/VerifierBase.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Cold-storage cost of the verification calls the vault, the anchor and the relayer make.
contract VerdictVerifierGasTest is VerifierBase {
    using stdJson for string;

    bytes32 internal constant TDX_2OF2 = 0x855bde51f8ebabd512a23a1d741a223c53c6eb0c4a15676533631180e832b2e1;
    bytes32 internal constant NITRO_2OF2 = 0x7e8dafdd6da7db2709a134e245088d13c8aad4b38900c048c2f8a12f8b213f53;

    bytes32 internal digest;
    bytes internal sigs;

    function setUp() public override {
        super.setUp();
        string memory v =
            vm.readFile(string.concat(vm.projectRoot(), "/../packages/core/test/vectors/countersign-2of2.json"));
        digest = v.readBytes32(".allow.digest");
        sigs = bytes.concat(v.readBytes(".allow.signatures.tdx"), v.readBytes(".allow.signatures.nitro"));
        _signersAction(abi.encodeCall(verifier.setAllowedMeasurement, (TDX_2OF2, true)));
        _signersAction(abi.encodeCall(verifier.setAllowedMeasurement, (NITRO_2OF2, true)));
        // The real legs' signer records: their registration needs ArbSys and EIP-2935, tested on the live chain.
        uint40 now_ = uint40(vm.getBlockTimestamp());
        _storeSigner(v.readAddress(".allow.signers.tdx"), 1, TDX_2OF2, now_, now_ + verifier.SIGNER_TTL());
        _storeSigner(v.readAddress(".allow.signers.nitro"), 2, NITRO_2OF2, now_, now_ + verifier.SIGNER_TTL());
    }

    function test_gas_verify2of2_cold() public {
        bytes memory both = sigs;
        bool ok = verifier.verify2of2(digest, both);
        uint256 used = vm.lastCallGas().gasTotalUsed;
        assertTrue(ok);
        emit log_named_uint("verify2of2 cold", used);
        GasBudget.check("verify2of2_cold", used);
    }

    function test_gas_verifyDegraded_cold() public {
        bytes memory tdx = new bytes(65);
        for (uint256 i; i < 65; ++i) {
            tdx[i] = sigs[i];
        }
        // The 2-of-2 TDX signer alone: degraded verification accepts any active TDX signer.
        bool ok = verifier.verifyDegraded(digest, tdx);
        uint256 used = vm.lastCallGas().gasTotalUsed;
        assertTrue(ok);
        emit log_named_uint("verifyDegraded cold", used);
        GasBudget.check("verifyDegraded_cold", used);
    }
}
