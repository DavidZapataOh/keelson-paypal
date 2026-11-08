// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ForkTest} from "./utils/Fork.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The local P256VERIFY precompile (EIP-7951) behaves like the one each chain runs.
/// @dev Osaka execution gives the local EVM the precompile at 0x100; `vm.setEvmVersion` does not enable it.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract PrecompilesForkTest is ForkTest {
    using stdJson for string;

    address internal constant P256VERIFY = address(0x100);

    /// @dev Wycheproof `ecdsa_secp256r1_sha256_test.json`, tcId 1: sha256("") ‖ r ‖ s ‖ x ‖ y.
    bytes internal constant VALID = abi.encodePacked(
        hex"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        hex"b292a619339f6e567a305c951c0dcbcc42d16e47f219f9e98e76e09d8770b34a",
        hex"0177e60492c5a8242f76f07bfe3661bde59ec2a17ce5bd2dab2abebdf89a62e2",
        hex"04aaec73635726f213fb8a9e64da3b8632e41495a944d0045b522eba7240fad5",
        hex"87d9315798aaa3a5ba01775787ced05eaaf7b4e09fc81d6d1aa546e8365d525d"
    );

    function setUp() public {
        _forkAll();
    }

    function _flippedS() internal pure returns (bytes memory input) {
        input = VALID;
        input[95] ^= 0x01;
    }

    function test_P256VerifyLocal() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            _select(CHAIN_IDS[i]);
            (bool ok, bytes memory out) = P256VERIFY.staticcall(VALID);
            assertTrue(ok);
            assertEq(abi.decode(out, (uint256)), 1, vm.toString(vm.getChainId()));
            (ok, out) = P256VERIFY.staticcall(_flippedS());
            assertTrue(ok);
            assertEq(out.length, 0, vm.toString(vm.getChainId()));
        }
    }

    function test_P256VerifyLive() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory rpc = vm.envString(_jsonOf(CHAIN_IDS[i]).readString(".rpcEnv"));
            string memory params =
                string.concat('[{"to":"', vm.toString(P256VERIFY), '","data":"', vm.toString(VALID), '"},"latest"]');
            bytes memory out = vm.rpc(rpc, "eth_call", params);
            assertEq(abi.decode(out, (uint256)), 1, vm.toString(CHAIN_IDS[i]));
        }
    }
}
