// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CheckpointAnchor} from "../../src/CheckpointAnchor.sol";
import {VerifierBase} from "./VerifierBase.sol";

/// @notice A `CheckpointAnchor` over the release's `VerdictVerifier`, with the live legs' signers recorded in the
/// registry, and the checkpoints of `vectors/checkpoints.json`: real notes signed by both live legs.
abstract contract AnchorBase is VerifierBase {
    /// @dev Fields in the alphabetical order `vm.parseJson` decodes them in.
    struct Case {
        bytes32[] consistencyFromPrevious;
        string name;
        string origin;
        bytes32 originHash;
        bytes32 root;
        bytes sigNitro;
        bytes sigTdx;
        string signedNote;
        uint256 size;
    }

    uint256 internal constant SANDBOX = 0;
    uint256 internal constant CONFORMANCE_8 = 1;
    uint256 internal constant CONFORMANCE_16 = 2;
    uint256 internal constant FORK_8 = 3;
    uint256 internal constant FORK_16 = 4;
    uint256 internal constant GAS_FROM = 5;
    uint256 internal constant GAS_TO = 6;

    CheckpointAnchor internal anchors;
    address internal tdxSigner;
    address internal nitroSigner;

    function setUp() public virtual override {
        super.setUp();
        anchors = new CheckpointAnchor(verifier);
        string memory json = _vectors();
        assertEq(vm.parseJsonUint(json, ".chainId"), CHAIN_ID);
        assertEq(vm.parseJsonAddress(json, ".verifyingContract"), address(verifier));
        tdxSigner = vm.parseJsonAddress(json, ".signers.tdx");
        nitroSigner = vm.parseJsonAddress(json, ".signers.nitro");
        // The legs' registrations need ArbSys and EIP-2935, so their records are written as the live chain holds them.
        bytes32[] memory m = deployScript.initialMeasurements();
        uint40 now_ = uint40(vm.getBlockTimestamp());
        _storeSigner(tdxSigner, 1, m[0], now_, now_ + verifier.SIGNER_TTL());
        _storeSigner(nitroSigner, 2, m[1], now_, now_ + verifier.SIGNER_TTL());
    }

    function _vectors() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/checkpoints.json"));
    }

    function _case(uint256 i) internal view returns (Case memory c) {
        c = abi.decode(vm.parseJson(_vectors(), string.concat(".cases[", vm.toString(i), "]")), (Case));
    }

    function _sigs(Case memory c) internal pure returns (bytes memory) {
        return bytes.concat(c.sigTdx, c.sigNitro);
    }

    function _anchor(Case memory c, bytes32[] memory proof) internal {
        anchors.anchor(c.originHash, uint64(c.size), c.root, proof, _sigs(c), bytes(c.signedNote));
    }

    function _anchor(Case memory c) internal {
        _anchor(c, c.consistencyFromPrevious);
    }
}
