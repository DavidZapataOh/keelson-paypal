// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployAmberContradictionCourt} from "../script/DeployAmberContradictionCourt.s.sol";
import {DeployViolationBondPool} from "../script/DeployViolationBondPool.s.sol";
import {AmberContradictionCourt} from "../src/AmberContradictionCourt.sol";
import {ViolationBondPool} from "../src/ViolationBondPool.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "../src/libraries/PasskeyAssertion.sol";
import {AmberEvidence} from "./utils/AmberEvidence.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {ViolationBase} from "./utils/ViolationBase.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Coverages whose operator attested a false amber field of the demo store's Tempo 3 in size 11, locked in a
/// vault deployed on a fork of Arbitrum Sepolia with real PYUSD; the `AmberContradictionCourt` convicts them with the
/// real C2b proofs of `test/vectors/c2b-*.json` and the `WebFact` the purchase's countersigned evidence holds, and the
/// `ViolationBondPool`, which lists the court through the timelock, pays the merchant once the vault and the reserve
/// can no longer pay the coverage. The countersigns and the `WebFact`s are signed by the fork-only TEE signers.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract AmberContradictionForkTest is ViolationBase {
    using stdJson for string;

    uint256 internal constant POOL_DEPOSIT = 200e6;
    /// @dev US cents: 20.00.
    uint64 internal constant AMOUNT = 2000;
    /// @dev The notary's session runs while the agent seals the evidence, before the countersign.
    uint40 internal constant CAPTURE_LEAD = 30 seconds;
    string internal constant URL = "https://store.keelson.finance/api/products/tempo-3/variants/RF-TMP3-11";

    AmberContradictionCourt internal amber;
    ViolationBondPool internal pool;
    uint40 internal issuedAt;

    struct AmberCase {
        KeelsonTypes.Coverage coverage;
        KeelsonTypes.Countersign countersign;
        bytes countersigs;
        KeelsonTypes.WebFact fact;
        bytes factSig;
        AmberContradictionCourt.EvidenceItem item;
        uint8 fieldId;
        bytes proof;
    }

    function setUp() public override {
        super.setUp();
        pool = new DeployViolationBondPool().run();
        DeployAmberContradictionCourt script = new DeployAmberContradictionCourt();
        address previous = script.predict("AmberContradictionCourt/2");
        vm.prank(address(_timelock()));
        pool.setCourt(previous, true);
        amber = script.run();
        assertNotEq(address(amber), previous, "a new address");
        assertFalse(pool.isCourt(address(amber)), "listed before the delay");
        vm.warp(vm.getBlockTimestamp() + _timelock().getMinDelay());
        script.list();
        assertTrue(pool.isCourt(address(amber)), "listed");
        assertFalse(pool.isCourt(previous), "the previous court delisted");
        _fundFromHolder(operator, POOL_DEPOSIT);
        vm.startPrank(operator);
        pyusd.approve(address(pool), POOL_DEPOSIT);
        pool.deposit(agentId, POOL_DEPOSIT);
        vm.stopPrank();
        // Late enough after the fork-only signers registered for a fact captured before the purchase.
        issuedAt = uint40(vm.getBlockTimestamp() + 2 hours);
    }

    function test_eachFalseField_isConvictedAndPaidOnceTheVaultCannotPay() public {
        string[4] memory fields = ["size", "color", "unitPrice", "returnsFree"];
        for (uint256 i; i < fields.length; ++i) {
            AmberCase memory k = _lockedAmber(fields[i], uint8(i + 1));
            uint256 before = pyusd.balanceOf(merchant);
            vm.expectEmit(address(amber));
            emit AmberContradictionCourt.AmberContradictionProven(
                k.coverage.coverageId, agentId, k.fieldId, _factDigest(k.fact)
            );
            vm.prank(makeAddr("anyone"));
            _slash(k);
            AmberContradictionCourt.Conviction memory v = amber.convictions(k.coverage.coverageId);
            assertEq(v.fieldId, k.fieldId, fields[i]);
            assertEq(v.webFactDigest, _factDigest(k.fact));
            (uint8 code,,) = amber.violations(k.coverage.coverageId);
            assertEq(code, 0, "not payable while the vault can pay");
            vm.expectRevert(ViolationBondPool.NotConvicted.selector);
            pool.payViolation(address(amber), k.coverage);

            vm.warp(amber.payableAt(k.coverage.coverageId) + 1);
            (uint8 payable_, uint40 provenAt, bytes32 evidence) = amber.violations(k.coverage.coverageId);
            assertEq(payable_, k.fieldId);
            assertEq(provenAt, v.provenAt);
            assertEq(evidence, _factDigest(k.fact));
            pool.payViolation(address(amber), k.coverage);
            assertEq(pyusd.balanceOf(merchant) - before, k.coverage.amount, fields[i]);
        }
    }

    function test_gas_slashAmber() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        _slash(k);
        GasBudget.check("c2b_slashAmber", vm.lastCallGas().gasTotalUsed);
    }

    /// @dev M3: the vault's slash inside its window takes its share; the pool pays only what is left, after the window.
    function test_aSlashBeforeThePoolLeavesItTheRest() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        _slash(k);
        uint96 slashed = k.coverage.amount / 4;
        vault.slash(_verdictOf(k, slashed), treeSize, _sign2of2(_verdictOf(k, slashed)));
        uint256 before = pyusd.balanceOf(merchant);
        vm.warp(amber.payableAt(k.coverage.coverageId) + 1);
        pool.payViolation(address(amber), k.coverage);
        assertEq(pyusd.balanceOf(merchant) - before, k.coverage.amount - slashed);
    }

    /// @dev M3: once the pool may pay, the vault's slash is closed; the pool pays once.
    function test_afterThePoolPays_theVaultCannotSlashAndThePoolCannotPayAgain() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        _slash(k);
        vm.warp(amber.payableAt(k.coverage.coverageId) + 1);
        KeelsonTypes.Verdict memory v = _verdictOf(k, k.coverage.amount);
        pool.payViolation(address(amber), k.coverage);
        bytes memory sigs = _sign2of2(v);
        vm.expectRevert(IKeelsonBondVault.CoverageNotActive.selector);
        vault.slash(v, treeSize, sigs);
        vm.expectRevert(ViolationBondPool.AlreadyPaid.selector);
        pool.payViolation(address(amber), k.coverage);
    }

    /// @dev M3: the conviction is payable exactly when the vault's slash and the reserve's warranty are both closed.
    function testFuzz_payableOnlyOnceTheVaultAndReserveAreClosed(uint256 after_) public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        _slash(k);
        uint256 releaseAfter = vault.coverages(k.coverage.coverageId).releaseAfter;
        uint256 time = bound(after_, block.timestamp, releaseAfter + 2 * vault.params().disputeWindow);
        vm.warp(time);
        (uint8 code,,) = amber.violations(k.coverage.coverageId);
        bool reserveOpen = time <= releaseAfter + vault.params().disputeWindow;
        assertEq(code != 0, !reserveOpen && time > releaseAfter, "payable iff vault and reserve are closed");
    }

    /// @dev M2: a coverage the vault locked on the TDX leg alone is out of this court's reach.
    function test_aDegradedCoverage_isNotConvicted() public {
        AmberCase memory k = _amberCase("size", amber.SIZE());
        bytes memory both = k.countersigs;
        k.countersigs = _signCountersign(tdxKey, k.countersign);
        _lockAmber(k);
        _expectRevert(k, AmberContradictionCourt.InvalidCountersignature.selector);
        k.countersigs = both;
        _slash(k);
    }

    function test_afterTheCoveragesWindow_reverts() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        vm.warp(vault.coverages(k.coverage.coverageId).releaseAfter + 1);
        _expectRevert(k, AmberContradictionCourt.ConvictionWindowClosed.selector);
        vm.warp(vault.coverages(k.coverage.coverageId).releaseAfter);
        _slash(k);
    }

    function test_replay_reverts() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        _slash(k);
        _expectRevert(k, AmberContradictionCourt.AlreadyProven.selector);
    }

    function test_unknownField_reverts() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        k.fieldId = 0;
        _expectRevert(k, AmberContradictionCourt.UnknownField.selector);
        k.fieldId = 5;
        _expectRevert(k, AmberContradictionCourt.UnknownField.selector);
    }

    function test_proofOfAnotherField_reverts() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        k.fieldId = amber.COLOR();
        _expectRevert(k, AmberContradictionCourt.InvalidProof.selector);
        k.fieldId = amber.SIZE();
        k.proof = _proof("color");
        _expectRevert(k, AmberContradictionCourt.InvalidProof.selector);
    }

    function test_unlockedOrAlteredCoverage_reverts() public {
        AmberCase memory k = _amberCase("size", amber.SIZE());
        _expectRevert(k, AmberContradictionCourt.NotCovered.selector);
        _lockAmber(k);
        k.coverage.amberCommitment = keccak256("another attestation");
        _expectRevert(k, AmberContradictionCourt.NotCovered.selector);
    }

    function test_coverageWithoutAmber_reverts() public {
        AmberCase memory k = _amberCase("size", amber.SIZE());
        k.coverage.amberCommitment = bytes32(0);
        _lockAmber(k);
        _expectRevert(k, AmberContradictionCourt.NoAmberAttestation.selector);
    }

    /// @dev M1: every field `lockCoverage` checked; the rest of the countersign is held by both legs' signatures.
    function test_anotherCountersign_reverts() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        KeelsonTypes.Countersign memory cs = _copy(k.countersign);
        k.countersign.amount = AMOUNT + 1;
        _expectRevert(k, AmberContradictionCourt.CountersignMismatch.selector);
        k.countersign = _copy(cs);
        k.countersign.decision = 2;
        _expectRevert(k, AmberContradictionCourt.CountersignMismatch.selector);
        k.countersign = _copy(cs);
        k.countersign.currency = 978;
        _expectRevert(k, AmberContradictionCourt.CountersignMismatch.selector);
        k.countersign = _copy(cs);
        k.countersign.requestId = keccak256("another purchase");
        _expectRevert(k, AmberContradictionCourt.CountersignMismatch.selector);
        k.countersign = _copy(cs);
        k.countersign.issuedAt += 1;
        _expectRevert(k, AmberContradictionCourt.InvalidCountersignature.selector);
        k.countersign = _copy(cs);
        k.countersign.evidenceRoot = keccak256("other evidence");
        _expectRevert(k, AmberContradictionCourt.InvalidCountersignature.selector);
    }

    function test_oneOrForeignCountersignatures_revert() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        bytes memory both = k.countersigs;
        k.countersigs = _signCountersign(tdxKey, k.countersign);
        _expectRevert(k, AmberContradictionCourt.InvalidCountersignature.selector);
        (, uint256 stranger) = makeAddrAndKey("stranger");
        k.countersigs =
            bytes.concat(_signCountersign(stranger, k.countersign), _signCountersign(nitroKey, k.countersign));
        _expectRevert(k, AmberContradictionCourt.InvalidCountersignature.selector);
        k.countersigs = bytes.concat(_signCountersign(nitroKey, k.countersign), _signCountersign(tdxKey, k.countersign));
        _expectRevert(k, AmberContradictionCourt.InvalidCountersignature.selector);
        k.countersigs = bytes.concat(both, hex"00");
        _expectRevert(k, AmberContradictionCourt.InvalidCountersignature.selector);
        k.countersigs = both;
        _slash(k);
    }

    /// @dev H1: a `WebFact` leg A signed of the same page around the purchase, but not the one in its evidence.
    function test_aWebFactOutsideTheEvidence_reverts() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        k.fact.tCapture = issuedAt + 1 minutes;
        k.factSig = _signFact(tdxKey, k.fact);
        vm.warp(k.fact.tCapture);
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);
    }

    function test_anOpeningOfAnotherItemOrRoot_reverts() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        AmberContradictionCourt.EvidenceItem memory item = k.item;
        k.item = _copy(item);
        k.item.salt = keccak256("another salt");
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);
        k.item = _copy(item);
        k.item.index = 2;
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);
        k.item = _copy(item);
        k.item.size = 5;
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);
        k.item = _copy(item);
        k.item.index = 4;
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);
        k.item = _copy(item);
        k.item.path[0] = keccak256("another sibling");
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);
        k.item = _copy(item);
        k.item.document = bytes.concat(item.document, " ");
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);
        k.item = item;
        _slash(k);
    }

    /// @dev Only the item's own position, tree size and digest offset open it.
    function testFuzz_anyOtherOpening_reverts(uint64 index, uint64 size, uint256 digestAt) public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        vm.assume(index != k.item.index || size != k.item.size || digestAt != k.item.digestAt);
        k.item.index = index;
        k.item.size = size;
        k.item.digestAt = digestAt;
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);
    }

    /// @dev The opened item must name the `WebFact` in its `digest` member, read where `digestAt` says.
    function test_anItemNamingAnotherDigest_reverts() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        AmberContradictionCourt.EvidenceItem memory item = k.item;
        k.item = _copy(item);
        k.item.digestAt = item.digestAt + 1;
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);
        k.item.digestAt = item.document.length - 76;
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);
        k.item.digestAt = item.document.length + 1;
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);
        k.item.digestAt = type(uint256).max;
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);

        // Countersigned evidence whose item names another `WebFact` of the same session.
        AmberCase memory other = _amberCase("color", amber.COLOR());
        KeelsonTypes.WebFact memory fact = _copy(other.fact);
        KeelsonTypes.WebFact memory named = _copy(fact);
        named.attId = keccak256("another attestation");
        _setEvidence(other, named);
        other.fact = fact;
        other.factSig = _signFact(tdxKey, fact);
        _lockAmber(other);
        _expectRevert(other, AmberContradictionCourt.WebFactNotInEvidence.selector);
    }

    /// @dev The same document, sealed as another item type, is not the `WebFact` item.
    function test_aDocumentUnderAnotherItemType_reverts() public {
        AmberCase memory k = _amberCase("size", amber.SIZE());
        bytes32 asProduct = AmberEvidence.leaf("api.product", k.item.salt, k.item.document);
        k.countersign.evidenceRoot = _rootOver(asProduct, k.item.path);
        k.countersigs = _countersign(k.countersign);
        _lockAmber(k);
        _expectRevert(k, AmberContradictionCourt.WebFactNotInEvidence.selector);
    }

    function test_webFactNotSignedByAnActiveTdxSigner_reverts() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        k.factSig = _signFact(nitroKey, k.fact);
        _expectRevert(k, AmberContradictionCourt.InvalidWebFact.selector);
        (, uint256 stranger) = makeAddrAndKey("stranger");
        k.factSig = _signFact(stranger, k.fact);
        _expectRevert(k, AmberContradictionCourt.InvalidWebFact.selector);
        k.factSig = bytes.concat(_signFact(tdxKey, k.fact), hex"00");
        _expectRevert(k, AmberContradictionCourt.InvalidWebFact.selector);
        k.factSig = _signFact(tdxKey, k.fact);
        k.fact.attId = keccak256("another attestation");
        _expectRevert(k, AmberContradictionCourt.InvalidWebFact.selector);
    }

    /// @dev Evidence that holds a `WebFact` of another page or range: the proof does not open it.
    function test_webFactOfAnotherPageOrRange_reverts() public {
        string[3] memory cases = ["page", "host", "range"];
        for (uint256 i; i < cases.length; ++i) {
            AmberCase memory k = _amberCase(i == 0 ? "size" : i == 1 ? "color" : "unitPrice", uint8(i + 1));
            KeelsonTypes.WebFact memory f = _copy(k.fact);
            if (i == 0) f.urlPathHash = keccak256("/api/products/tempo-3/variants/RF-TMP3-10");
            if (i == 1) f.hostHash = keccak256("store.example");
            if (i == 2) f.rangeCommitment = bytes32(uint256(f.rangeCommitment) ^ 1);
            _setEvidence(k, f);
            _lockAmber(k);
            _expectRevert(k, AmberContradictionCourt.InvalidProof.selector);
        }
    }

    function _slash(AmberCase memory k) internal {
        amber.slashAmber(k.coverage, k.countersign, k.countersigs, k.fact, k.factSig, k.item, k.fieldId, k.proof);
    }

    function _expectRevert(AmberCase memory k, bytes4 selector) internal {
        vm.expectRevert(selector);
        _slash(k);
    }

    function _lockedAmber(string memory name, uint8 fieldId) internal returns (AmberCase memory k) {
        k = _amberCase(name, fieldId);
        _lockAmber(k);
    }

    /// @dev Locked at the countersign's issue time, as the relayer submits it; disputed from then on.
    function _lockAmber(AmberCase memory k) internal {
        vm.warp(k.countersign.issuedAt);
        (uint256 qx, uint256 qy) = vm.publicKeyP256(passkey);
        vault.lockCoverage(
            k.coverage,
            k.countersign,
            keccak256("payload"),
            _assert(k.countersign.mandateHash),
            bytes32(qx),
            bytes32(qy),
            _operatorSig(k.coverage),
            k.countersigs
        );
    }

    /// @dev The field's proof, a coverage whose amber commitment is the proof's, and evidence holding a `WebFact` of
    /// the demo store's Tempo 3 page whose range commitment is the proof's, captured just before the purchase.
    function _amberCase(string memory name, uint8 fieldId) internal view returns (AmberCase memory k) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c2b-", name, ".json"));
        bytes32[] memory inputs = json.readBytes32Array(".publicInputs");
        assertEq(uint256(inputs[4]), fieldId, "vector field");
        k.proof = json.readBytes(".proof");
        k.fieldId = fieldId;
        bytes32 commitment = keccak256(abi.encode("mandate", name));
        k.countersign = KeelsonTypes.Countersign({
            requestId: keccak256(abi.encode("c2b", name)),
            mandateHash: PasskeyAssertion.mandateChallenge(keccak256("payload"), commitment),
            mandateCommitment: commitment,
            cartHash: keccak256(abi.encode("cart", name)),
            agentId: agentId,
            merchantId: keccak256("mrc_runfast"),
            amount: AMOUNT,
            currency: 840,
            category: 21,
            evidenceRoot: bytes32(0),
            evalHash: keccak256("eval"),
            policySetHash: keccak256("policies"),
            decision: 1,
            failedFieldsMask: 0,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 15 minutes
        });
        (uint256 qx, uint256 qy) = vm.publicKeyP256(passkey);
        k.coverage = KeelsonTypes.Coverage({
            coverageId: k.countersign.requestId,
            agentId: agentId,
            merchant: merchant,
            amount: uint96(AMOUNT) * 10_000,
            premium: 0,
            expiresAt: issuedAt + 1 days,
            mandateHash: k.countersign.mandateHash,
            amberCommitment: inputs[2],
            userKeyHash: keccak256(abi.encodePacked(qx, qy))
        });
        _setEvidence(
            k,
            KeelsonTypes.WebFact({
                hostHash: keccak256("store.keelson.finance"),
                urlPathHash: keccak256("/api/products/tempo-3/variants/RF-TMP3-11"),
                tCapture: issuedAt - CAPTURE_LEAD,
                rangeCommitment: bytes32(uint256(inputs[0]) << 128 | uint256(inputs[1])),
                attId: keccak256("leg A's attestation")
            })
        );
    }

    /// @dev Seals `fact`, signed by leg A, as the purchase's `tlsn.web_fact` item and countersigns its evidence root.
    function _setEvidence(AmberCase memory k, KeelsonTypes.WebFact memory fact) internal view {
        k.fact = fact;
        k.factSig = _signFact(tdxKey, fact);
        bytes32 root;
        (k.item, root) = AmberEvidence.item(
            AmberEvidence.Notarized({
                fact: fact,
                digest: _factDigest(fact),
                signature: k.factSig,
                signer: vm.addr(tdxKey),
                url: URL,
                committed: bytes("{}"),
                blinder: bytes16(keccak256("blinder"))
            }),
            keccak256(abi.encode("salt", k.countersign.requestId))
        );
        k.countersign.evidenceRoot = root;
        k.countersigs = _countersign(k.countersign);
    }

    function _rootOver(bytes32 leaf, bytes32[] memory path) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes1(0x01), path[1], sha256(abi.encodePacked(bytes1(0x01), path[0], leaf))));
    }

    function _verdictOf(AmberCase memory k, uint96 amount) internal view returns (KeelsonTypes.Verdict memory) {
        return KeelsonTypes.Verdict({
            disputeId: keccak256(abi.encode("PP-D-amber", k.coverage.coverageId)),
            coverageId: k.coverage.coverageId,
            agentId: k.coverage.agentId,
            payee: merchant,
            amount: amount,
            ruleId: R61,
            liable: OPERATOR,
            fieldId: VARIANT_FIELD,
            evidenceHash: keccak256("evidence"),
            inputsHash: keccak256("inputs"),
            policySetHash: k.countersign.policySetHash,
            checkpointRoot: checkpointRoot,
            issuedAt: uint40(vm.getBlockTimestamp()),
            deadline: uint40(vm.getBlockTimestamp() + 1 hours)
        });
    }

    function _proof(string memory name) internal view returns (bytes memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c2b-", name, ".json")).readBytes(".proof");
    }

    function _factDigest(KeelsonTypes.WebFact memory f) internal view returns (bytes32) {
        return verdictVerifier.hashTypedData(KeelsonTypes.hash(f));
    }

    function _signFact(uint256 pk, KeelsonTypes.WebFact memory f) internal view returns (bytes memory) {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(pk, _factDigest(f));
        return abi.encodePacked(r, s, sv);
    }

    function _copy(KeelsonTypes.Countersign memory cs) internal pure returns (KeelsonTypes.Countersign memory) {
        return abi.decode(abi.encode(cs), (KeelsonTypes.Countersign));
    }

    function _copy(KeelsonTypes.WebFact memory f) internal pure returns (KeelsonTypes.WebFact memory) {
        return abi.decode(abi.encode(f), (KeelsonTypes.WebFact));
    }

    function _copy(AmberContradictionCourt.EvidenceItem memory it)
        internal
        pure
        returns (AmberContradictionCourt.EvidenceItem memory)
    {
        return abi.decode(abi.encode(it), (AmberContradictionCourt.EvidenceItem));
    }
}
