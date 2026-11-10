// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployAmberContradictionCourt} from "../script/DeployAmberContradictionCourt.s.sol";
import {DeployViolationBondPool} from "../script/DeployViolationBondPool.s.sol";
import {AmberContradictionCourt} from "../src/AmberContradictionCourt.sol";
import {ViolationBondPool} from "../src/ViolationBondPool.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "../src/libraries/PasskeyAssertion.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {ViolationBase} from "./utils/ViolationBase.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Coverages whose operator attested a false amber field of the demo store's Tempo 3 in size 11, locked in a
/// vault deployed on a fork of Arbitrum Sepolia with real PYUSD; the `AmberContradictionCourt` convicts them with the
/// real C2b proofs of `test/vectors/c2b-*.json`, and the `ViolationBondPool`, which lists the court through the
/// timelock, pays the merchant. The countersigns and the `WebFact`s are signed by the fork-only TEE signers.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract AmberContradictionForkTest is ViolationBase {
    using stdJson for string;

    uint256 internal constant POOL_DEPOSIT = 200e6;
    /// @dev US cents: 20.00.
    uint64 internal constant AMOUNT = 2000;
    uint40 internal constant CAPTURE_DELAY = 30 seconds;

    AmberContradictionCourt internal amber;
    ViolationBondPool internal pool;
    uint40 internal issuedAt;

    struct AmberCase {
        KeelsonTypes.Coverage coverage;
        KeelsonTypes.Countersign countersign;
        bytes countersigs;
        KeelsonTypes.WebFact fact;
        bytes factSig;
        uint8 fieldId;
        bytes proof;
    }

    function setUp() public override {
        super.setUp();
        pool = new DeployViolationBondPool().run();
        DeployAmberContradictionCourt script = new DeployAmberContradictionCourt();
        amber = script.run();
        assertFalse(pool.isCourt(address(amber)), "listed before the delay");
        vm.warp(vm.getBlockTimestamp() + _timelock().getMinDelay());
        script.list();
        assertTrue(pool.isCourt(address(amber)), "listed");
        _fundFromHolder(operator, POOL_DEPOSIT);
        vm.startPrank(operator);
        pyusd.approve(address(pool), POOL_DEPOSIT);
        pool.deposit(agentId, POOL_DEPOSIT);
        vm.stopPrank();
        // Late enough after the fork-only signers registered for a fact captured `FACT_LEAD` before the purchase.
        issuedAt = uint40(vm.getBlockTimestamp() + 2 hours);
    }

    function test_eachFalseField_isConvictedAndPaid() public {
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
            (uint8 code,, bytes32 evidence) = amber.violations(k.coverage.coverageId);
            assertEq(code, k.fieldId, fields[i]);
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

    function test_aDegradedCoverage_isConvictedOnTheTdxCountersign() public {
        AmberCase memory k = _amberCase("size", amber.SIZE());
        k.countersigs = _signCountersign(tdxKey, k.countersign);
        _lockAmber(k);
        _slash(k);
        (uint8 code,,) = amber.violations(k.coverage.coverageId);
        assertEq(code, amber.SIZE());
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

    function test_anotherCountersign_reverts() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        k.countersign.amount = AMOUNT + 1;
        _expectRevert(k, AmberContradictionCourt.CountersignMismatch.selector);
        k.countersign.amount = AMOUNT;
        k.countersign.decision = 2;
        _expectRevert(k, AmberContradictionCourt.CountersignMismatch.selector);
        k.countersign.decision = 1;
        k.countersign.issuedAt += 1;
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
        k.countersigs = both;
        _slash(k);
    }

    function test_webFactCapturedOutsideThePurchase_reverts() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        k.fact.tCapture = issuedAt - amber.FACT_LEAD() - 1;
        k.factSig = _signFact(tdxKey, k.fact);
        _expectRevert(k, AmberContradictionCourt.StaleWebFact.selector);
        k.fact.tCapture = k.coverage.expiresAt + 1;
        k.factSig = _signFact(tdxKey, k.fact);
        _expectRevert(k, AmberContradictionCourt.StaleWebFact.selector);
        k.fact.tCapture = issuedAt - amber.FACT_LEAD();
        k.factSig = _signFact(tdxKey, k.fact);
        _slash(k);
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

    function test_webFactOfAnotherPageOrRange_reverts() public {
        AmberCase memory k = _lockedAmber("size", amber.SIZE());
        KeelsonTypes.WebFact memory fact = k.fact;
        k.fact.urlPathHash = keccak256("/api/products/trail-runner-2");
        k.factSig = _signFact(tdxKey, k.fact);
        _expectRevert(k, AmberContradictionCourt.InvalidProof.selector);
        k.fact = fact;
        k.fact.hostHash = keccak256("store.example");
        k.factSig = _signFact(tdxKey, k.fact);
        _expectRevert(k, AmberContradictionCourt.InvalidProof.selector);
        k.fact = fact;
        k.fact.rangeCommitment = bytes32(uint256(fact.rangeCommitment) ^ 1);
        k.factSig = _signFact(tdxKey, k.fact);
        _expectRevert(k, AmberContradictionCourt.InvalidProof.selector);
    }

    function _slash(AmberCase memory k) internal {
        amber.slashAmber(k.coverage, k.countersign, k.countersigs, k.fact, k.factSig, k.fieldId, k.proof);
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
        vm.warp(k.fact.tCapture);
    }

    /// @dev The field's proof, a coverage whose amber commitment is the proof's, and a `WebFact` of the demo store's
    /// Tempo 3 page whose range commitment is the proof's, captured just after the purchase.
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
            evidenceRoot: keccak256("evidence"),
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
        k.countersigs = _countersign(k.countersign);
        k.fact = KeelsonTypes.WebFact({
            hostHash: keccak256("store.keelson.finance"),
            urlPathHash: keccak256("/api/products/tempo-3"),
            tCapture: issuedAt + CAPTURE_DELAY,
            rangeCommitment: bytes32(uint256(inputs[0]) << 128 | uint256(inputs[1])),
            attId: keccak256("leg A's attestation")
        });
        k.factSig = _signFact(tdxKey, k.fact);
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
}
