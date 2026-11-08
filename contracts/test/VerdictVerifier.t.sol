// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IVerdictVerifier} from "../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {VerifierBase} from "./utils/VerifierBase.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";
import {IAccessManager} from "@openzeppelin/contracts/access/manager/IAccessManager.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice Verification against the real countersigns of the legs (`packages/core/test/vectors`), and governance.
contract VerdictVerifierTest is VerifierBase {
    using stdJson for string;

    uint8 internal constant TDX = 1;
    uint8 internal constant NITRO = 2;
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    /// @dev The measurements of the builds that signed the vectors, from the history of `engine/tee/measurements.json`.
    bytes32 internal constant TDX_2OF2 = 0x855bde51f8ebabd512a23a1d741a223c53c6eb0c4a15676533631180e832b2e1;
    bytes32 internal constant NITRO_2OF2 = 0x7e8dafdd6da7db2709a134e245088d13c8aad4b38900c048c2f8a12f8b213f53;
    bytes32 internal constant TDX_DEGRADED = 0x1c5c569dab08a41c50699e43dafa6600d4a8d78d6b1262e5f06e71466037a3d1;

    string internal twoOfTwo;
    string internal degraded;
    address internal tdxSigner;
    address internal nitroSigner;
    address internal degradedSigner;
    uint40 internal expiresAt;

    function setUp() public override {
        super.setUp();
        string memory dir = string.concat(vm.projectRoot(), "/../packages/core/test/vectors/");
        twoOfTwo = vm.readFile(string.concat(dir, "countersign-2of2.json"));
        degraded = vm.readFile(string.concat(dir, "countersign-degraded.json"));
        tdxSigner = twoOfTwo.readAddress(".allow.signers.tdx");
        nitroSigner = twoOfTwo.readAddress(".allow.signers.nitro");
        degradedSigner = degraded.readAddress(".degraded.signers.tdx");

        _signersAction(abi.encodeCall(verifier.setAllowedMeasurement, (TDX_2OF2, true)));
        _signersAction(abi.encodeCall(verifier.setAllowedMeasurement, (NITRO_2OF2, true)));
        _signersAction(abi.encodeCall(verifier.setAllowedMeasurement, (TDX_DEGRADED, true)));

        // The real legs' signer records: their registration needs ArbSys and EIP-2935, tested on the live chain.
        uint40 now_ = uint40(vm.getBlockTimestamp());
        expiresAt = now_ + verifier.SIGNER_TTL();
        _storeSigner(tdxSigner, TDX, TDX_2OF2, now_, expiresAt);
        _storeSigner(nitroSigner, NITRO, NITRO_2OF2, now_, expiresAt);
        _storeSigner(degradedSigner, TDX, TDX_DEGRADED, now_, expiresAt);
    }

    function _pair(string memory key) internal view returns (bytes32 digest, bytes memory tdx, bytes memory nitro) {
        digest = twoOfTwo.readBytes32(string.concat(key, ".digest"));
        tdx = twoOfTwo.readBytes(string.concat(key, ".signatures.tdx"));
        nitro = twoOfTwo.readBytes(string.concat(key, ".signatures.nitro"));
    }

    // ------------------------------------------------------------ verify2of2 / verifyDegraded

    function test_Verify2of2RealAllowAndDeny() public view {
        (bytes32 digest, bytes memory tdx, bytes memory nitro) = _pair(".allow");
        assertTrue(verifier.verify2of2(digest, bytes.concat(tdx, nitro)));
        (digest, tdx, nitro) = _pair(".deny");
        assertTrue(verifier.verify2of2(digest, bytes.concat(tdx, nitro)));
    }

    function test_Verify2of2RejectsWrongShapes() public view {
        (bytes32 digest, bytes memory tdx, bytes memory nitro) = _pair(".allow");
        assertFalse(verifier.verify2of2(digest, bytes.concat(nitro, tdx)), "swapped");
        assertFalse(verifier.verify2of2(digest, bytes.concat(tdx, tdx)), "two tdx");
        assertFalse(verifier.verify2of2(digest, bytes.concat(nitro, nitro)), "two nitro");
        bytes memory both = bytes.concat(tdx, nitro);
        assertFalse(verifier.verify2of2(digest, _cut(both, 129)), "129 bytes");
        assertFalse(verifier.verify2of2(digest, bytes.concat(both, hex"00")), "131 bytes");
        assertFalse(verifier.verify2of2(bytes32(uint256(digest) ^ 1), both), "other digest");
    }

    function test_Verify2of2RejectsHighS() public view {
        (bytes32 digest, bytes memory tdx, bytes memory nitro) = _pair(".allow");
        assertFalse(verifier.verify2of2(digest, bytes.concat(_malleate(tdx), nitro)));
        assertFalse(verifier.verify2of2(digest, bytes.concat(tdx, _malleate(nitro))));
    }

    function test_Verify2of2RejectsBadV() public view {
        (bytes32 digest, bytes memory tdx, bytes memory nitro) = _pair(".allow");
        tdx[64] = bytes1(uint8(29));
        assertFalse(verifier.verify2of2(digest, bytes.concat(tdx, nitro)));
    }

    function test_Verify2of2FalseAtExpiry() public {
        (bytes32 digest, bytes memory tdx, bytes memory nitro) = _pair(".allow");
        vm.warp(expiresAt - 1);
        assertTrue(verifier.verify2of2(digest, bytes.concat(tdx, nitro)));
        vm.warp(expiresAt);
        assertFalse(verifier.verify2of2(digest, bytes.concat(tdx, nitro)));
    }

    function test_Verify2of2FalseAfterRevoke() public {
        (bytes32 digest, bytes memory tdx, bytes memory nitro) = _pair(".allow");
        _guardianExec(address(verifier), abi.encodeCall(verifier.revokeSigner, (nitroSigner)));
        assertFalse(verifier.verify2of2(digest, bytes.concat(tdx, nitro)));
        assertFalse(verifier.isActive(nitroSigner, NITRO));
    }

    function test_Verify2of2FalseAfterMeasurementDisallowed() public {
        (bytes32 digest, bytes memory tdx, bytes memory nitro) = _pair(".allow");
        _signersAction(abi.encodeCall(verifier.setAllowedMeasurement, (TDX_2OF2, false)));
        assertFalse(verifier.verify2of2(digest, bytes.concat(tdx, nitro)));
    }

    function test_VerifyDegraded() public view {
        bytes32 digest = degraded.readBytes32(".degraded.digest");
        bytes memory sig = degraded.readBytes(".degraded.signatures.tdx");
        assertTrue(verifier.verifyDegraded(digest, sig));
        assertFalse(verifier.verify2of2(digest, bytes.concat(sig, sig)));
        assertFalse(verifier.verifyDegraded(digest, bytes.concat(sig, sig)), "130 bytes");

        (bytes32 allow,, bytes memory nitro) = _pair(".allow");
        assertFalse(verifier.verifyDegraded(allow, nitro), "nitro alone");
    }

    function test_IsActiveChecksKind() public view {
        assertTrue(verifier.isActive(tdxSigner, TDX));
        assertFalse(verifier.isActive(tdxSigner, NITRO));
        assertFalse(verifier.isActive(address(0), 0));
    }

    // ------------------------------------------------------------ governance

    function test_RevertWhen_GuardianAllowsMeasurement() public {
        vm.prank(address(guardian));
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, address(guardian)));
        verifier.setAllowedMeasurement(bytes32(uint256(1)), true);
    }

    function test_RevertWhen_TimelockSkipsSignersDelay() public {
        bytes memory call = abi.encodeCall(verifier.setAllowedMeasurement, (bytes32(uint256(1)), true));
        _viaTimelock(address(manager), abi.encodeCall(manager.schedule, (address(verifier), call, 0)));
        bytes32 id = manager.hashOperation(address(timelock), address(verifier), call);
        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(IAccessManager.AccessManagerNotReady.selector, id));
        verifier.setAllowedMeasurement(bytes32(uint256(1)), true);
    }

    function test_AllowMeasurementAfterBothDelays() public {
        bytes32 m = bytes32(uint256(1));
        vm.recordLogs();
        _signersAction(abi.encodeCall(verifier.setAllowedMeasurement, (m, true)));
        assertTrue(verifier.allowedMeasurement(m));
        _assertEmitted(abi.encodePacked(IVerdictVerifier.MeasurementAllowed.selector, m), abi.encode(true));
    }

    function test_SetIssuerAfterBothDelays() public {
        bytes memory call = abi.encodeCall(verifier.setIssuer, (bytes32(uint256(2))));
        vm.prank(address(timelock));
        vm.expectRevert();
        verifier.setIssuer(bytes32(uint256(2)));
        vm.recordLogs();
        _signersAction(call);
        assertEq(verifier.issuer(), bytes32(uint256(2)));
        _assertEmitted(abi.encodePacked(IVerdictVerifier.IssuerSet.selector), abi.encode(bytes32(uint256(2))));
    }

    function test_GuardianRevokesWithoutDelay() public {
        vm.recordLogs();
        _guardianExec(address(verifier), abi.encodeCall(verifier.revokeSigner, (tdxSigner)));
        (,,, uint40 revokedAt,) = verifier.signers(tdxSigner);
        assertEq(revokedAt, vm.getBlockTimestamp());
        _assertEmitted(
            abi.encodePacked(IVerdictVerifier.SignerRevoked.selector, bytes32(uint256(uint160(tdxSigner)))),
            abi.encode(uint40(vm.getBlockTimestamp()))
        );
    }

    function test_RevertWhen_AnyoneElseRevokes() public {
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, address(this)));
        verifier.revokeSigner(tdxSigner);
        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, address(timelock)));
        verifier.revokeSigner(tdxSigner);
    }

    function test_InitialState() public view {
        bytes32[] memory measurements = deployScript.initialMeasurements();
        assertTrue(verifier.allowedMeasurement(measurements[0]));
        assertTrue(verifier.allowedMeasurement(measurements[1]));
        assertEq(verifier.BOND_VAULT(), deployScript.predict("KeelsonBondVault"));
        assertEq(address(verifier), deployScript.predict("VerdictVerifier"));
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            verifier.eip712Domain();
        assertEq(name, "Keelson");
        assertEq(version, "1");
        assertEq(chainId, CHAIN_ID);
        assertEq(verifyingContract, address(verifier));
    }

    // ------------------------------------------------------------ equivocation

    function _countersign(string memory key) internal view returns (KeelsonTypes.Countersign memory c) {
        string memory p = string.concat(key, ".countersign");
        c.requestId = twoOfTwo.readBytes32(string.concat(p, ".requestId"));
        c.mandateHash = twoOfTwo.readBytes32(string.concat(p, ".mandateHash"));
        c.mandateCommitment = twoOfTwo.readBytes32(string.concat(p, ".mandateCommitment"));
        c.cartHash = twoOfTwo.readBytes32(string.concat(p, ".cartHash"));
        c.agentId = twoOfTwo.readUint(string.concat(p, ".agentId"));
        c.merchantId = twoOfTwo.readBytes32(string.concat(p, ".merchantId"));
        c.amount = uint64(twoOfTwo.readUint(string.concat(p, ".amount")));
        c.currency = uint16(twoOfTwo.readUint(string.concat(p, ".currency")));
        c.category = uint8(twoOfTwo.readUint(string.concat(p, ".category")));
        c.evidenceRoot = twoOfTwo.readBytes32(string.concat(p, ".evidenceRoot"));
        c.evalHash = twoOfTwo.readBytes32(string.concat(p, ".evalHash"));
        c.policySetHash = twoOfTwo.readBytes32(string.concat(p, ".policySetHash"));
        c.decision = uint8(twoOfTwo.readUint(string.concat(p, ".decision")));
        c.failedFieldsMask = uint32(twoOfTwo.readUint(string.concat(p, ".failedFieldsMask")));
        c.issuedAt = uint40(twoOfTwo.readUint(string.concat(p, ".issuedAt")));
        c.expiresAt = uint40(twoOfTwo.readUint(string.concat(p, ".expiresAt")));
    }

    function _sign(uint256 pk, KeelsonTypes.Countersign memory c) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, verifier.hashTypedData(KeelsonTypes.hash(c)));
        return abi.encodePacked(r, s, v);
    }

    function test_ReportEquivocationRevokes() public {
        // A locally generated key written as a registered signer: an honest leg never equivocates.
        (address key, uint256 pk) = makeAddrAndKey("equivocating");
        _storeSigner(key, TDX, TDX_2OF2, uint40(vm.getBlockTimestamp()), expiresAt);
        KeelsonTypes.Countersign memory a = _countersign(".allow");
        KeelsonTypes.Countersign memory b = _countersign(".allow");
        b.amount += 1;

        bytes32 digestA = verifier.hashTypedData(KeelsonTypes.hash(a));
        bytes32 digestB = verifier.hashTypedData(KeelsonTypes.hash(b));
        bytes memory sigA = _sign(pk, a);
        bytes memory sigB = _sign(pk, b);
        vm.expectEmit(address(verifier));
        emit IVerdictVerifier.SignerEquivocated(key, digestA, digestB);
        vm.expectEmit(address(verifier));
        emit IVerdictVerifier.SignerRevoked(key, uint40(vm.getBlockTimestamp()));
        verifier.reportEquivocation(a, b, sigA, sigB);
        assertFalse(verifier.isActive(key, TDX));
    }

    function test_RevertWhen_EquivocationIsNot() public {
        (address key, uint256 pk) = makeAddrAndKey("equivocating");
        _storeSigner(key, TDX, TDX_2OF2, uint40(vm.getBlockTimestamp()), expiresAt);
        KeelsonTypes.Countersign memory a = _countersign(".allow");
        KeelsonTypes.Countersign memory other = _countersign(".deny");

        bytes memory sigA = _sign(pk, a);
        bytes memory sigOther = _sign(pk, other);

        vm.expectRevert(IVerdictVerifier.NotEquivocation.selector);
        verifier.reportEquivocation(a, a, sigA, sigA);

        vm.expectRevert(IVerdictVerifier.NotEquivocation.selector);
        verifier.reportEquivocation(a, other, sigA, sigOther);

        (, uint256 stranger) = makeAddrAndKey("stranger");
        KeelsonTypes.Countersign memory b = _countersign(".allow");
        b.amount += 1;
        bytes memory strangerA = _sign(stranger, a);
        bytes memory strangerB = _sign(stranger, b);
        vm.expectRevert(IVerdictVerifier.NotEquivocation.selector);
        verifier.reportEquivocation(a, b, strangerA, strangerB);
    }

    function test_RevokedSignerCannotBeRevokedTwice() public {
        _guardianExec(address(verifier), abi.encodeCall(verifier.revokeSigner, (tdxSigner)));
        vm.prank(address(guardian));
        vm.expectRevert(IVerdictVerifier.SignerIsRevoked.selector);
        verifier.revokeSigner(tdxSigner);
    }

    /// @dev `topics` packed as 32-byte words; the log must come from the verifier.
    function _assertEmitted(bytes memory topics, bytes memory data) internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(verifier) && keccak256(abi.encodePacked(logs[i].topics)) == keccak256(topics)
            ) {
                assertEq(logs[i].data, data);
                return;
            }
        }
        revert("log not emitted");
    }

    function _cut(bytes memory b, uint256 length) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i; i < length; ++i) {
            out[i] = b[i];
        }
    }

    /// @dev The malleable twin `(r, n − s, v ^ 1)` of a low-S signature.
    function _malleate(bytes memory sig) internal pure returns (bytes memory) {
        (bytes32 r, bytes32 s) = abi.decode(sig, (bytes32, bytes32));
        return abi.encodePacked(r, bytes32(N - uint256(s)), uint8(sig[64]) == 27 ? uint8(28) : uint8(27));
    }
}
