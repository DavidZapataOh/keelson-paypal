// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IAutomataDcapAttestation} from "./interfaces/IAutomataDcapAttestation.sol";
import {INitroValidator} from "./interfaces/INitroValidator.sol";
import {IVerdictVerifier} from "./interfaces/IVerdictVerifier.sol";
import {DstackEvents, RuntimeEvent} from "./libraries/DstackEvents.sol";
import {KeelsonTypes} from "./libraries/KeelsonTypes.sol";
import {NitroDocument} from "./libraries/NitroDocument.sol";
import {TdxOutput} from "./libraries/TdxOutput.sol";
import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice Arbitrum's `ArbSys` precompile at `0x64`.
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

/// @title VerdictVerifier
/// @notice Registers a TEE signer only from a fresh, verified attestation whose `report_data` binds it to this chain,
/// the bond vault, the credential issuer and a recent block, and whose measurement is allowed; and verifies the
/// signatures of active signers. It is the `verifyingContract` of the EIP-712 domain of every message the TEEs sign.
/// @dev Intel TDX quotes are verified by Automata's DCAP attestation (on-chain, or from a zkVM proof), AWS Nitro
/// documents by Base's `NitroValidator`. A signer's key is born inside its enclave, so an attestation can only bind a
/// key that never left it. Not upgradeable.
contract VerdictVerifier is IVerdictVerifier, EIP712, AccessManaged {
    uint8 internal constant TDX = 1;
    uint8 internal constant NITRO = 2;
    uint40 public constant SIGNER_TTL = 72 hours;
    /// @notice One hour of Arbitrum blocks at 250 ms.
    uint256 public constant MAX_BLOCK_AGE_BLOCKS = 14_400;
    uint256 public constant NITRO_MAX_AGE = 1 hours;
    uint256 public constant NITRO_MAX_SKEW = 10 minutes;
    /// @dev Automata's `TCBStatus`: `OK` and `TCB_SW_HARDENING_NEEDED`.
    uint8 internal constant TCB_OK = 0;
    uint8 internal constant TCB_SW_HARDENING_NEEDED = 1;
    /// @dev Automata's `ZkCoProcessorType.RiscZero`.
    uint8 internal constant RISC_ZERO = 1;
    bytes32 internal constant BINDING_TAG = keccak256("KEELSON_TEE_SIGNER_V1");
    IArbSys internal constant ARB_SYS = IArbSys(address(0x64));
    /// @notice EIP-2935 block hash history. On Arbitrum it is keyed by L2 block number and keeps 393,168 blocks.
    address public constant BLOCK_HASH_HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;

    /// @inheritdoc IVerdictVerifier
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable BOND_VAULT;
    IAutomataDcapAttestation public immutable DCAP_ATTESTATION;
    IAutomataDcapAttestation public immutable ZK_DCAP_ATTESTATION;
    INitroValidator public immutable NITRO_VALIDATOR;

    /// @dev One slot for everything `isActive` reads, so a verification costs two cold reads per signer: the record
    /// and the allowlist entry of its measurement's first 16 bytes. Matching an allowed measurement's first 16 bytes
    /// with another SHA-256 measurement takes 2^128 work.
    struct Record {
        uint8 teeKind;
        uint40 registeredAt;
        uint40 expiresAt;
        uint40 revokedAt;
        bytes16 allowKey;
        bytes32 measurement;
    }

    /// @inheritdoc IVerdictVerifier
    bytes32 public issuer;
    mapping(bytes16 allowKey => bool) internal _allowed;
    mapping(address signer => Record) internal _signers;

    constructor(
        address authority,
        address bondVault,
        bytes32 issuer_,
        bytes32[] memory initialMeasurements,
        IAutomataDcapAttestation dcapAttestation,
        IAutomataDcapAttestation zkDcapAttestation,
        INitroValidator nitroValidator
    ) EIP712("Keelson", "1") AccessManaged(authority) {
        if (
            bondVault == address(0) || address(dcapAttestation) == address(0)
                || address(zkDcapAttestation) == address(0) || address(nitroValidator) == address(0)
        ) revert ZeroAddress();
        BOND_VAULT = bondVault;
        DCAP_ATTESTATION = dcapAttestation;
        ZK_DCAP_ATTESTATION = zkDcapAttestation;
        NITRO_VALIDATOR = nitroValidator;
        issuer = issuer_;
        emit IssuerSet(issuer_);
        for (uint256 i; i < initialMeasurements.length; ++i) {
            _allowed[_allowKey(initialMeasurements[i])] = true;
            emit MeasurementAllowed(initialMeasurements[i], true);
        }
    }

    // ---------------------------------------------------------------- registration

    /// @notice Registers, or extends, a TDX signer from a v4 quote that Automata verifies on-chain.
    /// @param events The quote's RTMR3 runtime events, in log order.
    /// @param blockNumber The L2 block whose hash is the second half of `report_data`.
    function registerSignerWithQuote(
        bytes calldata rawQuote,
        RuntimeEvent[] calldata events,
        SignerBinding calldata binding,
        uint256 blockNumber
    ) external payable {
        if (binding.teeKind != TDX) revert WrongTeeKind();
        (bool ok, bytes memory output) = DCAP_ATTESTATION.verifyAndAttestOnChain{value: msg.value}(rawQuote);
        if (!ok) revert AttestationFailed(string(output));
        _registerTdx(output, events, binding, blockNumber);
    }

    /// @notice Registers, or extends, a TDX signer from a RISC Zero proof of Automata's quote verification.
    /// @param output The guest program's journal.
    function registerSignerWithZkQuote(
        bytes calldata output,
        bytes calldata proof,
        RuntimeEvent[] calldata events,
        SignerBinding calldata binding,
        uint256 blockNumber
    ) external payable {
        if (binding.teeKind != TDX) revert WrongTeeKind();
        (bool ok, bytes memory verified) =
            ZK_DCAP_ATTESTATION.verifyAndAttestWithZKProof{value: msg.value}(output, RISC_ZERO, proof);
        if (!ok) revert AttestationFailed(string(verified));
        _registerTdx(verified, events, binding, blockNumber);
    }

    /// @notice Registers, or extends, a Nitro signer from an attestation document whose certificate chain is already
    /// cached in the `NitroValidator`'s `CertManager`.
    /// @param attestationTbs The document's COSE_Sign1 to-be-signed bytes.
    /// @param signature The document's 96-byte P-384 signature.
    /// @param attestationSigHints The inverse hints for `signature`, which the validator re-checks.
    function registerSignerWithNitro(
        bytes calldata attestationTbs,
        bytes calldata signature,
        bytes calldata attestationSigHints,
        SignerBinding calldata binding,
        uint256 blockNumber
    ) external {
        if (binding.teeKind != NITRO) revert WrongTeeKind();
        INitroValidator.Ptrs memory ptrs =
            NITRO_VALIDATOR.validateAttestationWithHints(attestationTbs, signature, attestationSigHints);
        NitroDocument.Fields memory doc = NitroDocument.read(attestationTbs, ptrs);
        if (doc.userData.length != 64) revert BindingMismatch();
        _checkBinding(binding, doc.userData, blockNumber);
        if (keccak256(doc.nonce) != keccak256(_slice(doc.userData, 32, 32))) revert NitroNonceMismatch();
        if (doc.key != binding.signer) revert NitroKeyMismatch();
        uint256 attestedAt = doc.timestampMs / 1000;
        if (attestedAt + NITRO_MAX_AGE < block.timestamp || attestedAt > block.timestamp + NITRO_MAX_SKEW) {
            revert NitroDocumentStale();
        }
        _admit(binding.signer, NITRO, doc.measurement);
    }

    function _registerTdx(
        bytes memory output,
        RuntimeEvent[] calldata events,
        SignerBinding calldata binding,
        uint256 blockNumber
    ) internal {
        TdxOutput.Td10 memory td = TdxOutput.parse(output);
        // Intel's SWHardeningNeeded is accepted only when it names the advisories, so they are on record.
        if (td.tcbStatus != TCB_OK && !(td.tcbStatus == TCB_SW_HARDENING_NEEDED && td.hasAdvisories)) {
            revert TcbStatusNotAccepted(td.tcbStatus);
        }
        if (td.debug) revert TdDebug();
        if (keccak256(DstackEvents.replay(events)) != keccak256(td.rtmr3)) revert Rtmr3Mismatch();
        _checkBinding(binding, td.reportData, blockNumber);
        _admit(binding.signer, TDX, DstackEvents.tdxMeasurement(td.mrtd, td.rtmr0, td.rtmr1, td.rtmr2, events));
    }

    /// @dev `reportData` is `keccak256(abi.encode(BINDING_TAG, chainid, BOND_VAULT, teeKind, signer, policySetHash,
    /// engineBuildId, bootEpoch, issuerJwkThumbprint)) ‖ blockHash`, with the hash of a block at most
    /// `MAX_BLOCK_AGE_BLOCKS` old. `block.number` and `blockhash` are not used: on Arbitrum they are L1-based or reach
    /// only 256 blocks back.
    function _checkBinding(SignerBinding calldata b, bytes memory reportData, uint256 blockNumber) internal view {
        if (reportData.length != 64) revert BindingMismatch();
        bytes32 expected = keccak256(
            abi.encode(
                BINDING_TAG,
                block.chainid,
                BOND_VAULT,
                b.teeKind,
                b.signer,
                b.policySetHash,
                b.engineBuildId,
                b.bootEpoch,
                b.issuerJwkThumbprint
            )
        );
        (bytes32 bound, bytes32 blockHash) = abi.decode(reportData, (bytes32, bytes32));
        if (bound != expected) revert BindingMismatch();
        if (b.issuerJwkThumbprint != issuer) revert IssuerMismatch();
        uint256 current = ARB_SYS.arbBlockNumber();
        if (blockNumber >= current) revert UnknownBlock();
        if (current - blockNumber > MAX_BLOCK_AGE_BLOCKS) revert StaleBlock();
        (bool ok, bytes memory ret) = BLOCK_HASH_HISTORY.staticcall(abi.encode(blockNumber));
        if (!ok || ret.length != 32) revert UnknownBlock();
        if (abi.decode(ret, (bytes32)) != blockHash) revert BindingMismatch();
    }

    /// @dev A registration made after the previous one expired starts anew, so `registeredAt` never covers a gap.
    function _admit(address signer, uint8 teeKind, bytes32 measurement) internal {
        if (!allowedMeasurement(measurement)) revert MeasurementNotAllowed(measurement);
        Record storage s = _signers[signer];
        if (s.revokedAt != 0) revert SignerIsRevoked();
        if (s.registeredAt != 0 && (s.teeKind != teeKind || s.measurement != measurement)) revert SignerConflict();
        uint40 now_ = SafeCast.toUint40(block.timestamp);
        if (s.registeredAt == 0 || now_ >= s.expiresAt) {
            s.teeKind = teeKind;
            s.allowKey = _allowKey(measurement);
            s.measurement = measurement;
            s.registeredAt = now_;
        }
        s.expiresAt = now_ + SIGNER_TTL;
        // forge-lint: disable-next-line(reentrancy-events)
        emit SignerRegistered(signer, teeKind, measurement, s.registeredAt, s.expiresAt);
    }

    // ---------------------------------------------------------------- verification

    /// @inheritdoc IVerdictVerifier
    function isActive(address signer, uint8 teeKind) public view returns (bool) {
        Record storage s = _signers[signer];
        return s.teeKind == teeKind && s.revokedAt == 0 && block.timestamp < s.expiresAt && _allowed[s.allowKey];
    }

    /// @inheritdoc IVerdictVerifier
    function signers(address signer)
        external
        view
        returns (uint8 teeKind, uint40 registeredAt, uint40 expiresAt, uint40 revokedAt, bytes32 measurement)
    {
        Record storage s = _signers[signer];
        return (s.teeKind, s.registeredAt, s.expiresAt, s.revokedAt, s.measurement);
    }

    /// @inheritdoc IVerdictVerifier
    function allowedMeasurement(bytes32 measurement) public view returns (bool) {
        return _allowed[_allowKey(measurement)];
    }

    /// @inheritdoc IVerdictVerifier
    function verify2of2(bytes32 digest, bytes calldata sigs) external view returns (bool) {
        if (sigs.length != 130) return false;
        return isActive(_recover(digest, sigs[0:65]), TDX) && isActive(_recover(digest, sigs[65:130]), NITRO);
    }

    /// @inheritdoc IVerdictVerifier
    function verifyDegraded(bytes32 digest, bytes calldata sig) external view returns (bool) {
        if (sig.length != 65) return false;
        return isActive(_recover(digest, sig), TDX);
    }

    /// @inheritdoc IVerdictVerifier
    function hashTypedData(bytes32 structHash) external view returns (bytes32) {
        return _hashTypedDataV4(structHash);
    }

    /// @dev The zero address for a malformed or high-S signature; the zero address is never registered.
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        (signer,,) = ECDSA.tryRecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
    }

    // ---------------------------------------------------------------- governance and revocation

    /// @inheritdoc IVerdictVerifier
    function setAllowedMeasurement(bytes32 measurement, bool allowed) external restricted {
        _allowed[_allowKey(measurement)] = allowed;
        // forge-lint: disable-next-line(reentrancy-events)
        emit MeasurementAllowed(measurement, allowed);
    }

    /// @inheritdoc IVerdictVerifier
    function setIssuer(bytes32 issuer_) external restricted {
        issuer = issuer_;
        // forge-lint: disable-next-line(reentrancy-events)
        emit IssuerSet(issuer_);
    }

    /// @inheritdoc IVerdictVerifier
    function revokeSigner(address signer) external restricted {
        _revoke(signer);
    }

    /// @inheritdoc IVerdictVerifier
    function reportEquivocation(
        KeelsonTypes.Countersign calldata a,
        KeelsonTypes.Countersign calldata b,
        bytes calldata sigA,
        bytes calldata sigB
    ) external {
        bytes32 digestA = _hashTypedDataV4(KeelsonTypes.hash(a));
        bytes32 digestB = _hashTypedDataV4(KeelsonTypes.hash(b));
        if (a.requestId != b.requestId || digestA == digestB || sigA.length != 65 || sigB.length != 65) {
            revert NotEquivocation();
        }
        address signer = _recover(digestA, sigA);
        Record storage s = _signers[signer];
        if (signer == address(0) || signer != _recover(digestB, sigB) || s.registeredAt == 0 || s.revokedAt != 0) {
            revert NotEquivocation();
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit SignerEquivocated(signer, digestA, digestB);
        _revoke(signer);
    }

    function _revoke(address signer) internal {
        Record storage s = _signers[signer];
        if (s.revokedAt != 0) revert SignerIsRevoked();
        s.revokedAt = SafeCast.toUint40(block.timestamp);
        // forge-lint: disable-next-line(reentrancy-events)
        emit SignerRevoked(signer, s.revokedAt);
    }

    function _allowKey(bytes32 measurement) internal pure returns (bytes16) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes16(measurement);
    }

    function _slice(bytes memory data, uint256 start, uint256 length) private pure returns (bytes memory out) {
        out = new bytes(length);
        assembly ("memory-safe") {
            mcopy(add(out, 0x20), add(add(data, 0x20), start), length)
        }
    }
}
