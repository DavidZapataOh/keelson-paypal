// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {AmberContradictionCourt, IAmberContradictionVerifier, IAmberVault} from "../src/AmberContradictionCourt.sol";
import {KeelsonBondVault} from "../src/KeelsonBondVault.sol";
import {ViolationBondPool} from "../src/ViolationBondPool.sol";
import {IVerdictVerifier} from "../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "../src/libraries/PasskeyAssertion.sol";
import {AmberEvidence} from "./utils/AmberEvidence.sol";
import {ForkTest} from "./utils/Fork.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice An `AmberContradictionCourt` convicts an operator who attested a false size of the demo store's Tempo 3, from
/// a `WebFact` the live leg A signed as the notary of a real TLS session with the store (`test/vectors/c2b-live.json`),
/// sealed into the purchase's evidence as the agent seals it (`test/vectors/c2b-live-evidence.json`), and a real C2b
/// proof over that session's committed range; the deployed `ViolationBondPool` pays the merchant once the vault and the
/// reserve can no longer pay the coverage. On a fork of Arbitrum Sepolia at the vector's block, or `AMBER_FORK_BLOCK`;
/// the court is `AMBER_COURT` when set (the deployed one, at a block after its deployment), else one deployed on the
/// fork. No coverage on chain carries a false amber commitment, so the
/// purchase is locked on the fork: its countersign is signed by two fork-only keys written into the forked
/// `VerdictVerifier` under the live legs' measurements, the passkey is a fresh P-256 key and the operator's key one the
/// demo agent moves to.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract AmberContradictionLiveForkTest is ForkTest {
    using stdJson for string;

    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 internal constant MEASUREMENT_IDS_SLOT = 4;
    uint256 internal constant SIGNERS_SLOT = 7;
    /// @dev US cents: 1.00.
    uint64 internal constant AMOUNT = 100;
    /// @dev The countersign follows the evidence the notary's session was sealed into.
    uint40 internal constant PURCHASE_AFTER_CAPTURE = 20 seconds;

    struct Purchase {
        KeelsonTypes.Coverage c;
        KeelsonTypes.Countersign cs;
        bytes countersigs;
    }

    function test_aFalseSizeIsConvictedFromTheLiveWebFactAndPaid() public {
        string memory v = _vector();
        (KeelsonBondVault vault, AmberContradictionCourt court, ViolationBondPool pool) = _contracts();
        assertTrue(pool.isCourt(address(court)), "listed");
        IVerdictVerifier verifier = vault.verifier();
        KeelsonTypes.WebFact memory fact = _liveFact(v);
        assertEq(verifier.hashTypedData(KeelsonTypes.hash(fact)), v.readBytes32(".digest"), "live digest");
        (uint8 kind,,,,) = verifier.signers(v.readAddress(".signer"));
        assertEq(kind, 1, "leg A notary");
        assertEq(fact.hostHash, keccak256("store.keelson.finance"));
        assertEq(fact.urlPathHash, keccak256("/api/products/tempo-3/variants/RF-TMP3-11"));
        bytes32[] memory inputs = v.readBytes32Array(".publicInputs");
        assertEq(bytes32(uint256(inputs[0]) << 128 | uint256(inputs[1])), fact.rangeCommitment, "proof's range");

        // The purchase's evidence, sealed by the agent from the notary's answer.
        string memory e = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c2b-live-evidence.json"));
        AmberContradictionCourt.EvidenceItem memory item = AmberContradictionCourt.EvidenceItem({
            document: e.readBytes(".item.document"),
            salt: e.readBytes32(".item.salt"),
            index: uint64(e.readUint(".item.index")),
            size: uint64(e.readUint(".item.size")),
            path: e.readBytes32Array(".item.path"),
            digestAt: e.readUint(".item.digestAt")
        });
        (bytes memory agentDocument,) = AmberEvidence.document(_notarized(v, fact));
        assertEq(item.document, agentDocument, "the agent's JCS document");

        // The operator attested size 10 for the size-11 SKU the store's page lists.
        Purchase memory p =
            _lock(vault, verifier, v, fact.tCapture + PURCHASE_AFTER_CAPTURE, e.readBytes32(".root"), inputs[2]);
        vm.warp(p.cs.issuedAt + 1 minutes);
        vm.prank(makeAddr("the user's dispute agent"));
        court.slashAmber(
            p.c, p.cs, p.countersigs, fact, v.readBytes(".signature"), item, court.SIZE(), v.readBytes(".proof")
        );
        AmberContradictionCourt.Conviction memory conviction = court.convictions(p.c.coverageId);
        assertEq(conviction.fieldId, court.SIZE());
        assertEq(conviction.webFactDigest, v.readBytes32(".digest"));

        (address funder,) = _funder(0);
        _fundFromHolder(funder, p.c.amount);
        vm.startPrank(funder);
        _pyusd().approve(address(pool), p.c.amount);
        pool.deposit(p.c.agentId, p.c.amount);
        vm.stopPrank();
        vm.expectRevert(ViolationBondPool.NotConvicted.selector);
        pool.payViolation(address(court), p.c);
        vm.warp(court.payableAt(p.c.coverageId) + 1);
        uint256 before = _pyusd().balanceOf(p.c.merchant);
        pool.payViolation(address(court), p.c);
        assertEq(_pyusd().balanceOf(p.c.merchant) - before, p.c.amount);
    }

    /// @dev H1: the store answered size 10 when the operator bought, and its evidence holds that answer, notarized; the
    /// merchant then serves the notary size 11. The live WebFact of that later answer does not convict the honest
    /// operator, though it was captured a minute after the purchase.
    function test_H1_aLaterAnswerOfTheStoreDoesNotConvict() public {
        string memory v = _vector();
        (KeelsonBondVault vault, AmberContradictionCourt court,) = _contracts();
        IVerdictVerifier verifier = vault.verifier();
        KeelsonTypes.WebFact memory later = _liveFact(v);
        bytes32[] memory inputs = v.readBytes32Array(".publicInputs");
        uint40 issuedAt = later.tCapture - 1 minutes;

        // What the store answered at the purchase: size 10, which the operator attested.
        bytes memory answer = '{"sku":"RF-TMP3-11","size":"10","color":"blue","unit_minor":12900,"returns_free":true}';
        AmberEvidence.Notarized memory n = _notarized(v, later);
        n.fact = KeelsonTypes.WebFact({
            hostHash: later.hostHash,
            urlPathHash: later.urlPathHash,
            tCapture: issuedAt - 5 seconds,
            rangeCommitment: sha256(abi.encodePacked(answer, bytes16(keccak256("blinder")))),
            attId: later.attId
        });
        n.committed = answer;
        n.blinder = bytes16(keccak256("blinder"));
        n.digest = verifier.hashTypedData(KeelsonTypes.hash(n.fact));
        (AmberContradictionCourt.EvidenceItem memory item, bytes32 root) =
            AmberEvidence.item(n, keccak256("the purchase's salt"));

        Purchase memory p = _lock(vault, verifier, v, issuedAt, root, inputs[2]);
        vm.warp(later.tCapture);
        vm.prank(p.c.merchant);
        vm.expectRevert(AmberContradictionCourt.WebFactNotInEvidence.selector);
        court.slashAmber(p.c, p.cs, p.countersigs, later, v.readBytes(".signature"), item, 1, v.readBytes(".proof"));
    }

    function _vector() internal returns (string memory v) {
        v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c2b-live.json"));
        vm.createSelectFork(
            vm.envString("ARBITRUM_SEPOLIA_RPC_URL"), vm.envOr("AMBER_FORK_BLOCK", v.readUint(".forkBlock"))
        );
    }

    /// @dev The registry's vault and pool, and the court at `AMBER_COURT` when set, else one deployed here over the
    /// registry's verifier and listed as the timelock lists it.
    function _contracts()
        internal
        returns (KeelsonBondVault vault, AmberContradictionCourt court, ViolationBondPool pool)
    {
        string memory reg = _json();
        vault = KeelsonBondVault(reg.readAddress(".contracts.KeelsonBondVault"));
        pool = ViolationBondPool(reg.readAddress(".contracts.ViolationBondPool"));
        court = AmberContradictionCourt(vm.envOr("AMBER_COURT", address(0)));
        if (address(court) != address(0)) return (vault, court, pool);
        court = new AmberContradictionCourt(
            IAmberVault(address(vault)),
            vault.verifier(),
            IAmberContradictionVerifier(reg.readAddress(".contracts.AmberContradictionVerifier"))
        );
        vm.prank(reg.readAddress(".contracts.TimelockController"));
        pool.setCourt(address(court), true);
    }

    function _liveFact(string memory v) internal pure returns (KeelsonTypes.WebFact memory) {
        return KeelsonTypes.WebFact({
            hostHash: v.readBytes32(".webFact.hostHash"),
            urlPathHash: v.readBytes32(".webFact.urlPathHash"),
            tCapture: uint40(v.readUint(".webFact.tCapture")),
            rangeCommitment: v.readBytes32(".webFact.rangeCommitment"),
            attId: v.readBytes32(".webFact.attId")
        });
    }

    function _notarized(string memory v, KeelsonTypes.WebFact memory fact)
        internal
        pure
        returns (AmberEvidence.Notarized memory)
    {
        return AmberEvidence.Notarized({
            fact: fact,
            digest: v.readBytes32(".digest"),
            signature: v.readBytes(".signature"),
            signer: v.readAddress(".signer"),
            url: v.readString(".url"),
            committed: vm.parseBytes(string.concat("0x", v.readString(".committed"))),
            blinder: bytes16(
                vm.parseBytes32(string.concat("0x", v.readString(".blinder"), "00000000000000000000000000000000"))
            )
        });
    }

    /// @dev A purchase of the size-11 Tempo 3 countersigned at `issuedAt` over the evidence `evidenceRoot` and covered
    /// with `amberCommitment`, locked by the demo agent moved to a fresh owner key.
    function _lock(
        KeelsonBondVault vault,
        IVerdictVerifier verifier,
        string memory v,
        uint40 issuedAt,
        bytes32 evidenceRoot,
        bytes32 amberCommitment
    ) internal returns (Purchase memory p) {
        (uint256 tdxKey, uint256 nitroKey) = _countersignKeys(verifier, v, issuedAt);
        (address operator, uint256 operatorKey) = makeAddrAndKey("agent owner");
        uint256 agentId = _demoAgentId();
        address owner = _identity().ownerOf(agentId);
        vm.prank(owner);
        _identity().transferFrom(owner, operator, agentId);

        uint256 passkey = uint256(keccak256("the user's passkey")) % P256_N;
        (uint256 qx, uint256 qy) = vm.publicKeyP256(passkey);
        bytes32 hSd = keccak256("payload");
        bytes32 commitment = keccak256("mandate");
        p.cs = KeelsonTypes.Countersign({
            requestId: keccak256("a purchase of Tempo 3 in size 11"),
            mandateHash: PasskeyAssertion.mandateChallenge(hSd, commitment),
            mandateCommitment: commitment,
            cartHash: keccak256("cart"),
            agentId: agentId,
            merchantId: keccak256("mrc_runfast"),
            amount: AMOUNT,
            currency: 840,
            category: 21,
            evidenceRoot: evidenceRoot,
            evalHash: keccak256("eval"),
            policySetHash: keccak256("policies"),
            decision: 1,
            failedFieldsMask: 0,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 15 minutes
        });
        p.c = KeelsonTypes.Coverage({
            coverageId: p.cs.requestId,
            agentId: agentId,
            merchant: makeAddr("RunFast"),
            amount: uint96(AMOUNT) * 10_000,
            premium: 0,
            expiresAt: issuedAt + vault.params().disputeWindow,
            mandateHash: p.cs.mandateHash,
            amberCommitment: amberCommitment,
            userKeyHash: keccak256(abi.encodePacked(qx, qy))
        });
        bytes32 csDigest = verifier.hashTypedData(KeelsonTypes.hash(p.cs));
        p.countersigs = bytes.concat(_signDigest(tdxKey, csDigest), _signDigest(nitroKey, csDigest));

        vm.warp(issuedAt);
        vault.lockCoverage(
            p.c,
            p.cs,
            hSd,
            _passkeyAssertion(vault, passkey, p.cs.mandateHash),
            bytes32(qx),
            bytes32(qy),
            _signDigest(operatorKey, _vaultDigest(vault, KeelsonTypes.hash(p.c))),
            p.countersigs
        );
    }

    /// @dev Two keys written as a TDX and a Nitro signer registered just before `issuedAt`, at the slots
    /// `forge inspect VerdictVerifier storageLayout` reports, under the measurements of the live signers.
    function _countersignKeys(IVerdictVerifier verifier, string memory v, uint40 issuedAt)
        internal
        returns (uint256 tdxKey, uint256 nitroKey)
    {
        address tdx;
        address nitro;
        (tdx, tdxKey) = makeAddrAndKey("fork-only tdx countersign signer");
        (nitro, nitroKey) = makeAddrAndKey("fork-only nitro countersign signer");
        (,,,, bytes32 tdxMeasurement) = verifier.signers(v.readAddress(".signer"));
        (,,,, bytes32 nitroMeasurement) = verifier.signers(v.readAddress(".nitroSigner"));
        _writeSigner(verifier, tdx, 1, tdxMeasurement, issuedAt - 1);
        _writeSigner(verifier, nitro, 2, nitroMeasurement, issuedAt - 1);
    }

    function _writeSigner(
        IVerdictVerifier verifier,
        address signer,
        uint8 teeKind,
        bytes32 measurement,
        uint256 registeredAt
    ) internal {
        uint256 id = uint256(vm.load(address(verifier), keccak256(abi.encode(measurement, MEASUREMENT_IDS_SLOT))));
        assertGt(id, 0, "measurement registered");
        bytes32 slot = keccak256(abi.encode(signer, SIGNERS_SLOT));
        uint256 packed = uint256(teeKind) | registeredAt << 8 | uint256(type(uint40).max) << 48 | id << 128;
        vm.store(address(verifier), slot, bytes32(packed));
        vm.store(address(verifier), bytes32(uint256(slot) + 1), measurement);
    }

    function _signDigest(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, sv);
    }

    function _vaultDigest(KeelsonBondVault vault, bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash));
    }

    function _passkeyAssertion(KeelsonBondVault vault, uint256 passkey, bytes32 challenge)
        internal
        view
        returns (PasskeyAssertion.Assertion memory a)
    {
        a.authenticatorData = abi.encodePacked(vault.rpIdHash(), bytes1(0x05), bytes4(0));
        a.clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"https://keelson.finance"}'
        );
        a.typeIndex = 1;
        a.challengeIndex = 23;
        (a.r, a.s) =
            vm.signP256(passkey, sha256(abi.encodePacked(a.authenticatorData, sha256(bytes(a.clientDataJSON)))));
        if (uint256(a.s) > P256_N / 2) a.s = bytes32(P256_N - uint256(a.s));
    }
}
