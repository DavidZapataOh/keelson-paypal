// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployNitroValidator} from "../script/DeployNitroValidator.s.sol";
import {INitroValidator} from "../src/interfaces/INitroValidator.sol";
import {NitroDocument} from "../src/libraries/NitroDocument.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

interface ICertManager {
    function verifyCACertWithHints(bytes memory cert, bytes32 parentCertHash, bytes memory signatureHints)
        external
        returns (bytes32);

    function verifyClientCertWithHints(bytes memory cert, bytes32 parentCertHash, bytes memory signatureHints) external;
}

contract NitroDocumentHarness {
    INitroValidator internal immutable VALIDATOR;

    constructor(INitroValidator validator) {
        VALIDATOR = validator;
    }

    function read(bytes calldata tbs, bytes calldata signature, bytes calldata hints)
        external
        returns (NitroDocument.Fields memory)
    {
        return NitroDocument.read(tbs, VALIDATOR.validateAttestationWithHints(tbs, signature, hints));
    }
}

/// @notice Leg B's live attestation document through the `nitro-validator` deployed by its script, on a fork of
/// Arbitrum Sepolia inside the document's leaf certificate validity.
contract NitroDocumentForkTest is Test {
    using stdJson for string;

    bytes32 internal constant BINDING_TAG = keccak256("KEELSON_TEE_SIGNER_V1");

    string internal live;
    DeployNitroValidator.Nitro internal nitro;
    NitroDocumentHarness internal harness;

    function setUp() public {
        live = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/nitro-attestation.json"));
        vm.createSelectFork(vm.envString("ARBITRUM_SEPOLIA_RPC_URL"), live.readUint(".block.number") + 40);
        nitro = new DeployNitroValidator().run();
        harness = new NitroDocumentHarness(INitroValidator(nitro.validator));
    }

    /// @dev Caches each certificate of the chain in order and returns the gas of each call.
    function _cacheChain(string memory json) internal returns (uint256[] memory gas) {
        ICertManager manager = ICertManager(nitro.certManager);
        uint256 count;
        while (json.keyExists(string.concat(".certs[", vm.toString(count), "]"))) ++count;
        gas = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            string memory path = string.concat(".certs[", vm.toString(i), "]");
            bytes memory cert = json.readBytes(string.concat(path, ".cert"));
            bytes32 parent = json.readBytes32(string.concat(path, ".parentCertHash"));
            bytes memory hints = json.readBytes(string.concat(path, ".hints"));
            if (json.readBool(string.concat(path, ".leaf"))) manager.verifyClientCertWithHints(cert, parent, hints);
            else manager.verifyCACertWithHints(cert, parent, hints);
            gas[i] = vm.lastCallGas().gasTotalUsed;
        }
    }

    function test_LiveDocumentReadsBackItsBinding() public {
        uint256[] memory gas = _cacheChain(live);
        for (uint256 i; i < gas.length; ++i) {
            emit log_named_uint(string.concat("cache certificate ", vm.toString(i)), gas[i]);
        }
        assertLe(gas[gas.length - 1], 8_000_000, "leaf cache");

        NitroDocument.Fields memory doc = harness.read(
            live.readBytes(".attestationTbs"), live.readBytes(".signature"), live.readBytes(".attestationHints")
        );
        uint256 validation = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("validate document", validation);
        assertLe(validation, 16_000_000, "document");

        assertEq(doc.measurement, live.readBytes32(".measurement"), "measurement");
        assertEq(doc.key, live.readAddress(".signer"), "signer");
        bytes32 blockHash = live.readBytes32(".block.hash");
        assertEq(doc.nonce, abi.encodePacked(blockHash), "nonce");
        bytes32 bound = keccak256(
            abi.encode(
                BINDING_TAG,
                live.readUint(".binding.chainId"),
                live.readAddress(".binding.bondVault"),
                uint8(live.readUint(".binding.teeKind")),
                live.readAddress(".binding.signer"),
                live.readBytes32(".binding.policySetHash"),
                live.readBytes32(".binding.engineBuildId"),
                uint64(live.readUint(".binding.bootEpoch")),
                live.readBytes32(".binding.issuerJwkThumbprint")
            )
        );
        assertEq(doc.userData, abi.encodePacked(bound, blockHash), "user data");
        assertGt(doc.timestampMs / 1000 + 1 hours, vm.getBlockTimestamp(), "fresh");
    }

    function test_RevertWhen_PcrByteChanged() public {
        _cacheChain(live);
        bytes memory tbs = live.readBytes(".attestationTbs");
        // PCR0 follows the `pcrs` text key as CBOR `0x00` (key 0) `0x5830` (a 48-byte string).
        uint256 pcr0 = _indexOf(tbs, hex"005830", _indexOf(tbs, hex"6470637273", 0)) + 3;
        tbs[pcr0] ^= 0x01;
        bytes memory signature = live.readBytes(".signature");
        bytes memory hints = live.readBytes(".attestationHints");
        // The signature hints are bound to the document hash, so the changed document fails their check.
        vm.expectRevert(bytes("bad inverse hint"));
        harness.read(tbs, signature, hints);
    }

    function test_RevertWhen_LeafExpired() public {
        string memory expired =
            vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/nitro-attestation-expired.json"));
        ICertManager manager = ICertManager(nitro.certManager);
        uint256 count;
        while (expired.keyExists(string.concat(".certs[", vm.toString(count), "]"))) ++count;
        for (uint256 i; i < count - 1; ++i) {
            string memory path = string.concat(".certs[", vm.toString(i), "]");
            try manager.verifyCACertWithHints(
                expired.readBytes(string.concat(path, ".cert")),
                expired.readBytes32(string.concat(path, ".parentCertHash")),
                expired.readBytes(string.concat(path, ".hints"))
            ) {}
                catch {}
        }
        string memory leaf = string.concat(".certs[", vm.toString(count - 1), "]");
        bytes memory cert = expired.readBytes(string.concat(leaf, ".cert"));
        bytes32 parent = expired.readBytes32(string.concat(leaf, ".parentCertHash"));
        bytes memory hints = expired.readBytes(string.concat(leaf, ".hints"));
        vm.expectRevert();
        manager.verifyClientCertWithHints(cert, parent, hints);
    }

    function _indexOf(bytes memory haystack, bytes memory needle, uint256 from) internal pure returns (uint256) {
        for (uint256 i = from; i + needle.length <= haystack.length; ++i) {
            bool found = true;
            for (uint256 j; j < needle.length && found; ++j) {
                found = haystack[i + j] == needle[j];
            }
            if (found) return i;
        }
        revert("not found");
    }
}
