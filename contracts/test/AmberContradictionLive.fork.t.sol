// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {AmberContradictionCourt} from "../src/AmberContradictionCourt.sol";
import {KeelsonBondVault} from "../src/KeelsonBondVault.sol";
import {ViolationBondPool} from "../src/ViolationBondPool.sol";
import {IVerdictVerifier} from "../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "../src/libraries/PasskeyAssertion.sol";
import {ForkTest} from "./utils/Fork.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The deployed `AmberContradictionCourt` convicts an operator who attested a false size of the demo store's
/// Tempo 3, from a `WebFact` the live leg A signed as the notary of a real TLS session with the store
/// (`test/vectors/c2b-live.json`) and a real C2b proof over that session's committed range, and the deployed
/// `ViolationBondPool` pays the merchant, on a fork of Arbitrum Sepolia at the vector's block. No coverage on chain
/// carries an amber commitment yet, so the purchase is locked on the fork: its countersign is signed by two fork-only
/// keys written into the forked `VerdictVerifier` under the live legs' measurements, the passkey is a fresh P-256 key
/// and the operator's key one the demo agent moves to.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract AmberContradictionLiveForkTest is ForkTest {
    using stdJson for string;

    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 internal constant MEASUREMENT_IDS_SLOT = 4;
    uint256 internal constant SIGNERS_SLOT = 7;
    /// @dev US cents: 1.00.
    uint64 internal constant AMOUNT = 100;
    uint40 internal constant PURCHASE_BEFORE_CAPTURE = 1 minutes;

    function test_aFalseSizeIsConvictedFromTheLiveWebFactAndPaid() public {
        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c2b-live.json"));
        vm.createSelectFork(vm.envString("ARBITRUM_SEPOLIA_RPC_URL"), v.readUint(".forkBlock"));
        string memory reg = _json();
        KeelsonBondVault vault = KeelsonBondVault(reg.readAddress(".contracts.KeelsonBondVault"));
        AmberContradictionCourt court = AmberContradictionCourt(reg.readAddress(".contracts.AmberContradictionCourt"));
        ViolationBondPool pool = ViolationBondPool(reg.readAddress(".contracts.ViolationBondPool"));
        IVerdictVerifier verifier = vault.verifier();
        assertTrue(pool.isCourt(address(court)), "listed");

        KeelsonTypes.WebFact memory fact = KeelsonTypes.WebFact({
            hostHash: v.readBytes32(".webFact.hostHash"),
            urlPathHash: v.readBytes32(".webFact.urlPathHash"),
            tCapture: uint40(v.readUint(".webFact.tCapture")),
            rangeCommitment: v.readBytes32(".webFact.rangeCommitment"),
            attId: v.readBytes32(".webFact.attId")
        });
        assertEq(verifier.hashTypedData(KeelsonTypes.hash(fact)), v.readBytes32(".digest"), "live digest");
        (uint8 kind,,,,) = verifier.signers(v.readAddress(".signer"));
        assertEq(kind, 1, "leg A notary");
        assertEq(fact.hostHash, keccak256("store.keelson.finance"));
        assertEq(fact.urlPathHash, keccak256("/api/products/tempo-3/variants/RF-TMP3-11"));
        bytes32[] memory inputs = v.readBytes32Array(".publicInputs");
        assertEq(bytes32(uint256(inputs[0]) << 128 | uint256(inputs[1])), fact.rangeCommitment, "proof's range");

        uint40 issuedAt = fact.tCapture - PURCHASE_BEFORE_CAPTURE;
        (uint256 tdxKey, uint256 nitroKey) = _countersignKeys(verifier, v, issuedAt);
        (address operator, uint256 operatorKey) = makeAddrAndKey("agent owner");
        uint256 agentId = _demoAgentId();
        address owner = _identity().ownerOf(agentId);
        vm.prank(owner);
        _identity().transferFrom(owner, operator, agentId);
        address merchant = makeAddr("RunFast");

        uint256 passkey = uint256(keccak256("the user's passkey")) % P256_N;
        (uint256 qx, uint256 qy) = vm.publicKeyP256(passkey);
        bytes32 hSd = keccak256("payload");
        bytes32 commitment = keccak256("mandate");
        KeelsonTypes.Countersign memory cs = KeelsonTypes.Countersign({
            requestId: keccak256("a purchase of Tempo 3 in size 11"),
            mandateHash: PasskeyAssertion.mandateChallenge(hSd, commitment),
            mandateCommitment: commitment,
            cartHash: keccak256("cart"),
            agentId: agentId,
            merchantId: keccak256("mrc_runfast"),
            amount: AMOUNT,
            currency: 840,
            category: 21,
            evidenceRoot: keccak256("evidence"),
            evalHash: keccak256("eval"),
            policySetHash: keccak256("policies"),
            decision: 1,
            failedFieldsMask: 0,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 15 minutes
        });
        KeelsonTypes.Coverage memory c = KeelsonTypes.Coverage({
            coverageId: cs.requestId,
            agentId: agentId,
            merchant: merchant,
            amount: uint96(AMOUNT) * 10_000,
            premium: 0,
            expiresAt: issuedAt + vault.params().disputeWindow,
            mandateHash: cs.mandateHash,
            // The operator attested size 10 for the size-11 SKU the store's page lists.
            amberCommitment: inputs[2],
            userKeyHash: keccak256(abi.encodePacked(qx, qy))
        });
        bytes32 csDigest = verifier.hashTypedData(KeelsonTypes.hash(cs));
        bytes memory countersigs = bytes.concat(_signDigest(tdxKey, csDigest), _signDigest(nitroKey, csDigest));

        vm.warp(issuedAt);
        vault.lockCoverage(
            c,
            cs,
            hSd,
            _passkeyAssertion(vault, passkey, cs.mandateHash),
            bytes32(qx),
            bytes32(qy),
            _signDigest(operatorKey, _vaultDigest(vault, KeelsonTypes.hash(c))),
            countersigs
        );
        vm.warp(fact.tCapture + PURCHASE_BEFORE_CAPTURE);

        vm.prank(makeAddr("the user's dispute agent"));
        court.slashAmber(c, cs, countersigs, fact, v.readBytes(".signature"), court.SIZE(), v.readBytes(".proof"));
        (uint8 code,, bytes32 evidence) = court.violations(c.coverageId);
        assertEq(code, court.SIZE());
        assertEq(evidence, v.readBytes32(".digest"));

        (address funder,) = _funder(0);
        _fundFromHolder(funder, c.amount);
        vm.startPrank(funder);
        _pyusd().approve(address(pool), c.amount);
        pool.deposit(agentId, c.amount);
        vm.stopPrank();
        uint256 before = _pyusd().balanceOf(merchant);
        pool.payViolation(address(court), c);
        assertEq(_pyusd().balanceOf(merchant) - before, c.amount);
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
