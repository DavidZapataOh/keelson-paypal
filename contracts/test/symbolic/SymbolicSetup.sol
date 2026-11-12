// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CheckpointAnchor} from "../../src/CheckpointAnchor.sol";
import {KeelsonBondVault} from "../../src/KeelsonBondVault.sol";
import {KeelsonReserve} from "../../src/KeelsonReserve.sol";
import {VerdictVerifier} from "../../src/VerdictVerifier.sol";
import {IAutomataDcapAttestation} from "../../src/interfaces/IAutomataDcapAttestation.sol";
import {ICheckpointAnchor} from "../../src/interfaces/ICheckpointAnchor.sol";
import {IERC8004Identity} from "../../src/interfaces/IERC8004Identity.sol";
import {IKeelsonBondVault} from "../../src/interfaces/IKeelsonBondVault.sol";
import {INitroValidator} from "../../src/interfaces/INitroValidator.sol";
import {IPYUSD} from "../../src/interfaces/IPYUSD.sol";
import {IVerdictVerifier} from "../../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Test} from "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";

/// @notice OpenZeppelin's ERC-20, standing in for PYUSD: a symbolic EVM cannot fork the chain.
contract SymbolicToken is ERC20 {
    constructor() ERC20("Token", "TKN") {
        _mint(msg.sender, type(uint128).max);
    }
}

/// @notice Exposes the verifier's internal admission, which registration reaches only from a real TEE attestation.
contract AdmittingVerdictVerifier is VerdictVerifier {
    constructor(address authority, address bondVault, bytes32[] memory measurements, address attestation)
        VerdictVerifier(
            authority,
            bondVault,
            bytes32(0),
            measurements,
            IAutomataDcapAttestation(attestation),
            INitroValidator(attestation)
        )
    {}

    function admit(address signer, uint8 teeKind, bytes32 measurement) external {
        _admit(signer, teeKind, measurement);
    }
}

/// @notice The real vault, reserve, verifier and anchor deployed locally, with one TDX and one Nitro signer admitted,
/// one anchored checkpoint, and two coverages of the same agent: one locked 2-of-2 and one degraded.
/// @dev `lockCoverage` needs a P-256 passkey assertion (precompile 0x100), which symbolic engines do not execute, so the
/// coverages, their bond and the vault's balance are written as `lockCoverage` leaves them. Its own checks are covered by
/// the fork suites.
abstract contract SymbolicSetup is SymTest, Test {
    uint8 internal constant TDX = 1;
    uint8 internal constant NITRO = 2;
    uint8 internal constant OPERATOR = 1;
    uint8 internal constant KEELSON = 2;
    uint256 internal constant TDX_KEY = 0x7d1;
    uint256 internal constant NITRO_KEY = 0x417f0;
    address internal constant TDX_ADDRESS = 0xe89476B7cc8fA1E503F2ae4A43e53EDa4bFBAC07;
    address internal constant NITRO_ADDRESS = 0x734dD32B8d2c25b64cAafeeB38eb3CC095360bCA;
    /// @dev Plain constants: `makeAddr` goes through `vm.addr`, which Halmos does not compute.
    address internal constant MERCHANT = address(0x3e7c4a47);
    address internal constant STAKER = address(0x57a4e7);
    uint256 internal constant AGENT = 351;
    bytes32 internal constant COVERAGE = keccak256("coverage");
    bytes32 internal constant DEGRADED_COVERAGE = keccak256("degraded coverage");
    uint96 internal constant COVERAGE_AMOUNT = 100e6;
    uint128 internal constant FREE = 50e6;
    uint96 internal constant INSTANT_CAP = 25e6;
    uint40 internal constant DISPUTE_WINDOW = 1 days;
    uint40 internal constant VETO_WINDOW = 1 days;
    uint40 internal constant GRACE = 1 hours;
    uint40 internal constant WITHDRAWAL_DELAY = 3 days;
    uint256 internal constant RESERVE_ASSETS = 1_000e6;
    uint40 internal constant COOLDOWN = 10 days;
    uint64 internal constant TREE_SIZE = 1;
    string internal constant ORIGIN = "keelson.finance/symbolic";
    bytes32 internal constant TDX_MEASUREMENT = keccak256("tdx measurement");
    bytes32 internal constant NITRO_MEASUREMENT = keccak256("nitro measurement");
    uint256 internal constant BONDS_SLOT = 6;
    uint256 internal constant COVERAGES_SLOT = 7;
    uint256 internal constant WITHDRAWALS_SLOT = 14;
    uint256 internal constant ANCHOR_ROOTS_SLOT = 1;
    /// @dev `_warrantyLimit`, the reserve's last non-mapping slot, takes slots 17 and 18.
    uint256 internal constant RESERVE_LAST_SLOT = 18;
    address internal constant RESERVE = address(0x4e5e7e);
    /// @dev Never read: only `lockCoverage` checks passkey assertions.
    bytes32 internal constant RP_ID_HASH = keccak256("rp id");

    SymbolicToken internal token;
    AccessManager internal manager;
    AdmittingVerdictVerifier internal verifier;
    CheckpointAnchor internal anchor;
    KeelsonReserve internal reserve;
    KeelsonBondVault internal vault;
    address internal tdx;
    address internal nitro;
    bytes32 internal logOrigin;
    bytes32 internal checkpointRoot;
    uint40 internal start;
    uint40 internal releaseAfter;

    function setUp() public virtual {
        start = uint40(block.timestamp);
        token = new SymbolicToken();
        manager = new AccessManager(address(this));
        tdx = vm.addr(TDX_KEY);
        nitro = vm.addr(NITRO_KEY);
        // Halmos models `vm.addr` as an uninterpreted function: the keys' real addresses keep its signers distinct and
        // non-zero.
        vm.assume(tdx == TDX_ADDRESS && nitro == NITRO_ADDRESS);

        bytes32[] memory measurements = new bytes32[](2);
        measurements[0] = TDX_MEASUREMENT;
        measurements[1] = NITRO_MEASUREMENT;
        // The vault address the signers bind to matters only to registration, which these checks do not reach.
        verifier = new AdmittingVerdictVerifier(address(manager), RESERVE, measurements, address(token));
        verifier.admit(tdx, TDX, TDX_MEASUREMENT);
        verifier.admit(nitro, NITRO, NITRO_MEASUREMENT);
        anchor = new CheckpointAnchor(IVerdictVerifier(address(verifier)));
        logOrigin = keccak256(bytes(ORIGIN));
        vault = new KeelsonBondVault(
            IPYUSD(address(token)),
            IVerdictVerifier(address(verifier)),
            ICheckpointAnchor(address(anchor)),
            IERC8004Identity(address(manager)),
            RESERVE,
            logOrigin,
            RP_ID_HASH,
            address(manager),
            IKeelsonBondVault.Params({
                disputeWindow: DISPUTE_WINDOW,
                vetoWindow: VETO_WINDOW,
                grace: GRACE,
                withdrawalDelay: WITHDRAWAL_DELAY,
                instantSlashCap: INSTANT_CAP
            }),
            1 days,
            1_000e6
        );
        KeelsonReserve deployed = new KeelsonReserve(
            token,
            IVerdictVerifier(address(verifier)),
            ICheckpointAnchor(address(anchor)),
            IKeelsonBondVault(address(vault)),
            logOrigin,
            address(manager),
            COOLDOWN,
            1 days,
            uint208(RESERVE_ASSETS)
        );
        // The vault and the reserve name each other, and symbolic engines do not derive CREATE addresses from nonces: the
        // reserve is moved, code and storage, to the address the vault was built with.
        vm.etch(RESERVE, address(deployed).code);
        for (uint256 slot; slot <= RESERVE_LAST_SLOT; ++slot) {
            vm.store(RESERVE, bytes32(slot), vm.load(address(deployed), bytes32(slot)));
        }
        reserve = KeelsonReserve(RESERVE);

        checkpointRoot = keccak256("checkpoint root");
        _anchorCheckpoint();

        releaseAfter = start + DISPUTE_WINDOW + GRACE;
        _storeBond(FREE, 2 * COVERAGE_AMOUNT, 0);
        _storeCoverage(COVERAGE, releaseAfter, false);
        _storeCoverage(DEGRADED_COVERAGE, start + 72 hours, true);
        assertTrue(token.transfer(address(vault), FREE + 2 * COVERAGE_AMOUNT));
        assertEq(vault.bonds(AGENT).locked, 2 * COVERAGE_AMOUNT);
        assertEq(vault.coverages(COVERAGE).amount, COVERAGE_AMOUNT);
        assertTrue(vault.coverages(DEGRADED_COVERAGE).degraded);
        assertEq(vault.coverages(COVERAGE).releaseAfter, releaseAfter);
        assertTrue(token.transfer(address(reserve), RESERVE_ASSETS));
    }

    /// @dev Written as `anchor` leaves it: signing in `setUp` would split it into several symbolic paths, which Halmos
    /// refuses. Anchoring itself is checked by the anchor's own properties.
    function _anchorCheckpoint() internal {
        bytes32 inner = keccak256(abi.encode(logOrigin, ANCHOR_ROOTS_SLOT));
        vm.store(address(anchor), keccak256(abi.encode(TREE_SIZE, inner)), checkpointRoot);
        assertEq(anchor.rootAt(logOrigin, TREE_SIZE), checkpointRoot);
    }

    function _storeBond(uint128 free, uint128 locked, uint128 queued) internal {
        bytes32 slot = keccak256(abi.encode(AGENT, BONDS_SLOT));
        vm.store(address(vault), slot, bytes32(uint256(free) | uint256(locked) << 128));
        vm.store(address(vault), bytes32(uint256(slot) + 1), bytes32(uint256(queued)));
    }

    function _storeCoverage(bytes32 id, uint40 until, bool degraded) internal {
        uint256 packed = uint256(COVERAGE_AMOUNT) | AGENT << 96 | uint256(until) << 160
            | uint256(uint8(IKeelsonBondVault.Status.Active)) << 200 | (degraded ? uint256(1) << 208 : 0);
        vm.store(address(vault), keccak256(abi.encode(id, COVERAGES_SLOT)), bytes32(packed));
    }

    function _storeWithdrawal(uint256 id, uint128 amount, uint40 readyAt, address to) internal {
        bytes32 slot = keccak256(abi.encode(id, WITHDRAWALS_SLOT));
        vm.store(address(vault), slot, bytes32(uint256(amount) | AGENT << 128 | uint256(readyAt) << 192));
        vm.store(address(vault), bytes32(uint256(slot) + 1), bytes32(uint256(uint160(to))));
    }

    /// @dev A verdict against `coverageId` naming the anchored checkpoint; the caller makes the fields it needs symbolic.
    function _verdict(bytes32 disputeId, bytes32 coverageId, uint96 amount, uint8 liable)
        internal
        view
        returns (KeelsonTypes.Verdict memory)
    {
        return KeelsonTypes.Verdict({
            disputeId: disputeId,
            coverageId: coverageId,
            agentId: AGENT,
            payee: MERCHANT,
            amount: amount,
            ruleId: liable == OPERATOR ? 61 : 60,
            liable: liable,
            fieldId: 9,
            evidenceHash: keccak256("evidence"),
            inputsHash: keccak256("inputs"),
            policySetHash: keccak256("policy set"),
            checkpointRoot: checkpointRoot,
            issuedAt: start,
            deadline: start + 30 days
        });
    }

    function _digest(KeelsonTypes.Verdict memory v) internal view returns (bytes32) {
        return verifier.hashTypedData(KeelsonTypes.hash(v));
    }

    function _signWith(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sign2of2(bytes32 digest) internal pure returns (bytes memory) {
        return bytes.concat(_signWith(TDX_KEY, digest), _signWith(NITRO_KEY, digest));
    }

    function _slash(KeelsonTypes.Verdict memory v, bytes memory sigs) internal returns (bool ok) {
        (ok,) = address(vault).call(abi.encodeCall(vault.slash, (v, TREE_SIZE, sigs)));
    }

    function _payWarranty(KeelsonTypes.Verdict memory v, bytes memory sigs) internal returns (bool ok) {
        (ok,) = address(reserve).call(abi.encodeCall(reserve.payWarranty, (v, TREE_SIZE, sigs)));
    }

    /// @dev The signer `ecrecover` yields for one 65-byte signature, sliced as the verifier slices it.
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        return ecrecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
    }

    function _queued(bytes32 disputeId) internal view returns (IKeelsonBondVault.QueuedSlash memory) {
        return vault.queuedSlashes(disputeId);
    }
}
