// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IConvictions} from "./interfaces/IConvictions.sol";
import {IKeelsonBondVault} from "./interfaces/IKeelsonBondVault.sol";
import {IVerdictVerifier} from "./interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "./libraries/KeelsonTypes.sol";
import {RFC6962} from "./libraries/RFC6962.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice What the court reads from the `KeelsonBondVault`.
interface IAmberVault {
    /// @notice EIP-712 struct hash of each locked `Coverage`; 0 for none.
    function coverageHash(bytes32 coverageId) external view returns (bytes32);

    function coverages(bytes32 coverageId) external view returns (IKeelsonBondVault.CoverageState memory);

    function params() external view returns (IKeelsonBondVault.Params memory);
}

/// @notice bb's UltraHonk verifier of the C2b `amber_contradiction` circuit.
interface IAmberContradictionVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/// @title AmberContradictionCourt
/// @notice Records, once per coverage, that an amber field the coverage's operator attested is false: the store's own
/// server said otherwise in the TLS session the purchase's evidence holds, which the TLSNotary notary (leg A) signed as
/// a `WebFact`, and the C2b proof shows that the session's committed body is the attested item's JSON object (same SKU,
/// exactly its five fields) with another value of the field. The operator's `amberCommitment` in the locked coverage is
/// what the proof opens. No role, no owner; the `ViolationBondPool` pays the merchant once neither the vault nor the
/// reserve can pay the coverage any more.
/// @dev The `WebFact` must be the `tlsn.web_fact` item of the evidence both TEE legs countersigned for the purchase:
/// a store that later answers otherwise, or answers the notary otherwise, cannot convict. The countersign is matched to
/// the coverage on every field `lockCoverage` checked; each leg answers a request id once, and two countersigns under
/// one id are an equivocation the `VerdictVerifier` revokes the signers for.
contract AmberContradictionCourt is IConvictions {
    using SafeCast for uint256;

    struct Conviction {
        uint8 fieldId;
        uint40 provenAt;
        bytes32 webFactDigest;
    }

    /// @notice The purchase's `tlsn.web_fact` evidence item, opened as an Alibi discloses it: its bytes (the JCS
    /// document holding the signed `WebFact`), its salt, and its RFC 9162 inclusion path under the evidence root.
    struct EvidenceItem {
        bytes document;
        bytes32 salt;
        uint64 index;
        uint64 size;
        bytes32[] path;
        /// @notice Offset in `document` of the `"digest":"0x…"` member that names the `WebFact`'s EIP-712 digest.
        uint256 digestAt;
    }

    uint8 public constant SIZE = 1;
    uint8 public constant COLOR = 2;
    uint8 public constant UNIT_PRICE = 3;
    uint8 public constant RETURNS_FREE = 4;

    uint8 internal constant TDX = 1;
    uint8 internal constant NITRO = 2;
    uint8 internal constant ALLOW = 1;
    uint16 internal constant USD = 840;
    uint256 internal constant SIGNATURE_LENGTH = 65;
    /// @dev PYUSD base units per US cent, as the vault converts `Countersign.amount`.
    uint256 internal constant PYUSD_PER_MINOR = 10_000;
    uint256 internal constant BN254_FR_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// @dev `"digest":"` ‖ 66 characters of `0x`-prefixed lowercase hex ‖ `"`.
    uint256 internal constant DIGEST_MEMBER_LENGTH = 77;

    IAmberVault public immutable vault;
    IVerdictVerifier public immutable teeVerifier;
    IAmberContradictionVerifier public immutable proofVerifier;

    mapping(bytes32 coverageId => Conviction) internal _convictions;

    event AmberContradictionProven(
        bytes32 indexed coverageId, uint256 indexed agentId, uint8 fieldId, bytes32 webFactDigest
    );

    error AlreadyProven();
    error UnknownField();
    /// @notice The coverage is not one the vault locked, or not as given.
    error NotCovered();
    error NoAmberAttestation();
    /// @notice The countersign is not the ALLOW the coverage was locked with.
    error CountersignMismatch();
    /// @notice The countersign does not carry both legs' signatures.
    error InvalidCountersignature();
    error InvalidWebFact();
    /// @notice The `WebFact` is not the `tlsn.web_fact` item of the countersigned evidence.
    error WebFactNotInEvidence();
    error InvalidProof();

    constructor(IAmberVault vault_, IVerdictVerifier teeVerifier_, IAmberContradictionVerifier proofVerifier_) {
        vault = vault_;
        teeVerifier = teeVerifier_;
        proofVerifier = proofVerifier_;
    }

    /// @notice Convicts the operator of coverage `c` of a false amber `fieldId`.
    /// @param cs The countersign `c` was locked with.
    /// @param countersigs `tdx ‖ nitro`: both legs, whatever the vault accepted at the lock.
    /// @param fact The `WebFact` of the store's answer at the purchase, signed by leg A (`factSig`).
    /// @param item The countersign's `tlsn.web_fact` evidence item, which names `fact`.
    /// @param proof C2b over `range_hi, range_lo, amber_commitment, product, field_id`: the halves of
    /// `fact.rangeCommitment`, `c.amberCommitment`, `keccak256(abi.encode(fact.hostHash, fact.urlPathHash))` mod the
    /// BN254 scalar field, and `fieldId`.
    function slashAmber(
        KeelsonTypes.Coverage calldata c,
        KeelsonTypes.Countersign calldata cs,
        bytes calldata countersigs,
        KeelsonTypes.WebFact calldata fact,
        bytes calldata factSig,
        EvidenceItem calldata item,
        uint8 fieldId,
        bytes calldata proof
    ) external {
        if (fieldId == 0 || fieldId > RETURNS_FREE) revert UnknownField();
        if (_convictions[c.coverageId].fieldId != 0) revert AlreadyProven();
        bytes32 locked = vault.coverageHash(c.coverageId);
        if (locked == 0 || locked != KeelsonTypes.hash(c)) revert NotCovered();
        if (c.amberCommitment == 0) revert NoAmberAttestation();
        if (
            cs.requestId != c.coverageId || cs.agentId != c.agentId || cs.mandateHash != c.mandateHash
                || cs.decision != ALLOW || cs.currency != USD || uint256(cs.amount) * PYUSD_PER_MINOR != c.amount
        ) revert CountersignMismatch();
        bytes32 csDigest = teeVerifier.hashTypedData(KeelsonTypes.hash(cs));
        if (
            countersigs.length != 2 * SIGNATURE_LENGTH
                || !_signedAt(csDigest, countersigs[:SIGNATURE_LENGTH], TDX, cs.issuedAt)
                || !_signedAt(csDigest, countersigs[SIGNATURE_LENGTH:], NITRO, cs.issuedAt)
        ) revert InvalidCountersignature();
        bytes32 factDigest = teeVerifier.hashTypedData(KeelsonTypes.hash(fact));
        if (factSig.length != SIGNATURE_LENGTH || !_signedAt(factDigest, factSig, TDX, fact.tCapture)) {
            revert InvalidWebFact();
        }
        if (!_inEvidence(cs.evidenceRoot, factDigest, item)) revert WebFactNotInEvidence();

        bytes32[] memory inputs = new bytes32[](5);
        inputs[0] = fact.rangeCommitment >> 128;
        inputs[1] = bytes32(uint256(uint128(uint256(fact.rangeCommitment))));
        inputs[2] = c.amberCommitment;
        inputs[3] = bytes32(uint256(keccak256(abi.encode(fact.hostHash, fact.urlPathHash))) % BN254_FR_MODULUS);
        inputs[4] = bytes32(uint256(fieldId));
        // bb's verifiers revert on most failed checks and return false on the last one.
        try proofVerifier.verify(proof, inputs) returns (bool ok) {
            if (!ok) revert InvalidProof();
        } catch {
            revert InvalidProof();
        }

        _convictions[c.coverageId] =
            Conviction({fieldId: fieldId, provenAt: block.timestamp.toUint40(), webFactDigest: factDigest});
        // forge-lint: disable-next-line(reentrancy-events)
        emit AmberContradictionProven(c.coverageId, c.agentId, fieldId, factDigest);
    }

    /// @notice The conviction of a coverage as the `ViolationBondPool` pays it: `code` is the false field, and 0 for
    /// none or until `payableAt`.
    function violations(bytes32 coverageId)
        external
        view
        returns (uint8 code, uint40 provenAt, bytes32 evidenceDigest)
    {
        Conviction memory v = _convictions[coverageId];
        if (v.fieldId == 0 || block.timestamp <= payableAt(coverageId)) return (0, 0, 0);
        return (v.fieldId, v.provenAt, v.webFactDigest);
    }

    /// @notice The conviction of a coverage as recorded, payable or not.
    function convictions(bytes32 coverageId) external view returns (Conviction memory) {
        return _convictions[coverageId];
    }

    /// @notice The last time the vault's slash or the reserve's warranty can pay the coverage: the pool pays a conviction
    /// only after it, and only what they left, so the coverage is paid once.
    function payableAt(bytes32 coverageId) public view returns (uint256) {
        return uint256(vault.coverages(coverageId).releaseAfter) + vault.params().disputeWindow;
    }

    /// @dev Whether `item` is the `tlsn.web_fact` leaf of the evidence tree with root `root` and its document names
    /// `factDigest`. The leaf is `SHA-256(0x00 ‖ "keelson/evidence-item/v1" ‖ salt ‖ type ‖ 0x00 ‖ media_type ‖ 0x00 ‖
    /// SHA-256(document))`. In JSON, `"digest":"` can only be a member named `digest`: a quote inside a string is
    /// escaped.
    function _inEvidence(bytes32 root, bytes32 factDigest, EvidenceItem calldata item) internal view returns (bool) {
        bytes32 leaf = sha256(
            abi.encodePacked(
                bytes1(0x00),
                "keelson/evidence-item/v1",
                item.salt,
                "tlsn.web_fact",
                bytes1(0x00),
                "application/json",
                bytes1(0x00),
                sha256(item.document)
            )
        );
        (bytes32 computed, bool ok) = RFC6962.rootFromInclusion(item.index, item.size, leaf, item.path);
        if (!ok || computed != root) return false;
        if (item.digestAt > item.document.length || item.document.length - item.digestAt < DIGEST_MEMBER_LENGTH) {
            return false;
        }
        return keccak256(item.document[item.digestAt:item.digestAt + DIGEST_MEMBER_LENGTH])
            == keccak256(abi.encodePacked('"digest":"', Strings.toHexString(uint256(factDigest), 32), '"'));
    }

    /// @dev Whether a `teeKind` signer registered by `time`, still in that registration and never revoked, under a
    /// measurement still allowed, signed `digest`. Malformed and high-S signatures recover the zero address, which is
    /// never registered.
    function _signedAt(bytes32 digest, bytes calldata sig, uint8 teeKind, uint40 time) internal view returns (bool) {
        address signer = _recover(digest, sig);
        (uint8 kind, uint40 registeredAt, uint40 expiresAt, uint40 revokedAt, bytes32 measurement) =
            teeVerifier.signers(signer);
        return kind == teeKind && revokedAt == 0 && registeredAt != 0 && registeredAt <= time && time < expiresAt
            && teeVerifier.allowedMeasurement(measurement);
    }

    /// @dev A failed recovery returns the zero address, which no signer record holds.
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        // slither-disable-next-line unused-return
        (signer,,) = ECDSA.tryRecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
    }
}
