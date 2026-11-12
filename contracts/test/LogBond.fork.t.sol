// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployLogBond} from "../script/DeployLogBond.s.sol";
import {LogBond} from "../src/LogBond.sol";
import {IEd25519Verifier} from "../src/interfaces/IEd25519Verifier.sol";
import {ILogBond} from "../src/interfaces/ILogBond.sol";
import {RFC6962} from "../src/libraries/RFC6962.sol";
import {Ed25519Verifier} from "../src/verifiers/Ed25519Verifier.sol";
import {ForkTest} from "./utils/Fork.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {IPyusd} from "./utils/IPyusd.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Bonds on real PYUSD (an Arbitrum Sepolia fork) slashed with the real conformance checkpoints of
/// `vectors/checkpoints.json`: the honest tree and a fork of it, both signed by the conformance log key with the Go
/// `note` package, at sizes 8 and 16.
contract LogBondForkTest is ForkTest {
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

    /// @dev `services/log/keys/conformance-2026-1.vkey` and `alibi-2026-1.vkey`, without their type byte.
    bytes32 internal constant CONFORMANCE_KEY = 0xcee7c0b53e0c733a1a8d44870133fa7cf17187a502c7cf37e429eea5a8d565d5;
    bytes32 internal constant SANDBOX_KEY = 0xf06b6eb0cdc9bf6ec9736d8373d75e757129005c306a9ad4e942b7196db54057;
    uint40 internal constant DELAY = 1 days;
    uint40 internal constant WINDOW = 1 hours;
    uint16 internal constant BOUNTY_BPS = 1000;

    IPyusd internal pyusd;
    IEd25519Verifier internal ed;
    LogBond internal bond;
    address internal owner = makeAddr("owner");
    address internal prover = makeAddr("prover");
    address internal beneficiary = makeAddr("beneficiary");

    function setUp() public {
        string memory json = _jsonOf(421_614);
        vm.createSelectFork(vm.envString("ARBITRUM_SEPOLIA_RPC_URL"), vm.parseJsonUint(json, ".forkBlock"));
        pyusd = _pyusd();
        ed = new Ed25519Verifier();
        bond = _bond(_case(CONFORMANCE_8).originHash, CONFORMANCE_KEY);
        _fundFromHolder(owner, 100e6);
        vm.startPrank(owner);
        pyusd.approve(address(bond), type(uint256).max);
        bond.deposit(40e6);
        vm.stopPrank();
    }

    function _bond(bytes32 origin, bytes32 key) internal returns (LogBond) {
        return new LogBond(IERC20(address(pyusd)), ed, owner, origin, key, DELAY, WINDOW, beneficiary, BOUNTY_BPS);
    }

    function _case(uint256 i) internal view returns (Case memory c) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/checkpoints.json"));
        c = abi.decode(vm.parseJson(json, string.concat(".cases[", vm.toString(i), "]")), (Case));
    }

    function _note(uint256 i) internal view returns (bytes memory) {
        return bytes(_case(i).signedNote);
    }

    function _prove(bytes memory a, bytes memory b) internal {
        vm.prank(prover);
        bond.proveEquivocation(a, b);
    }

    function _expectProve(bytes memory err, bytes memory a, bytes memory b) internal {
        vm.expectRevert(err);
        _prove(a, b);
    }

    function test_pinsTheLogKey() public view {
        assertEq(bond.origin(), keccak256("log.keelson.finance/conformance/2026-1"));
        assertEq(bond.key(), CONFORMANCE_KEY);
        assertEq(address(bond.token()), address(pyusd));
        assertEq(bond.withdrawalDelay(), DELAY);
        assertFalse(bond.slashed());
    }

    function test_deployScriptLinksTheVerifier() public {
        vm.setEnv("LOG_BOND_NAME", "LogBondTestOrigin");
        vm.setEnv("LOG_BOND_ORIGIN", "log.keelson.finance/conformance/2026-1");
        vm.setEnv("LOG_BOND_KEY", vm.toString(CONFORMANCE_KEY));
        vm.setEnv("LOG_BOND_OWNER", vm.toString(owner));
        vm.setEnv("LOG_BOND_NOTE", vm.toString(_note(CONFORMANCE_16)));
        DeployLogBond script = new DeployLogBond();
        LogBond deployed = script.run();
        assertEq(address(deployed), script.predict("LogBondTestOrigin@2"));
        assertTrue(
            address(deployed) != vm.parseJsonAddress(_json(), ".contracts.LogBondTestOrigin"), "beside the first"
        );
        assertEq(deployed.owner(), owner);
        assertEq(deployed.withdrawalDelay(), 7 days);
        assertEq(deployed.completionWindow(), 1 days);
        assertEq(deployed.beneficiary(), vm.parseJsonAddress(_json(), ".contracts.KeelsonReserve"));
        assertEq(deployed.bountyBps(), 1000);
        (uint64 size,) = deployed.checkpoint(_note(FORK_8));
        assertEq(size, 8);
    }

    function test_checkpointOpensANoteOfTheKey() public {
        (uint64 size, bytes32 root) = bond.checkpoint(_note(FORK_16));
        assertEq(size, 16);
        assertEq(root, _case(FORK_16).root);
        vm.expectRevert(abi.encodeWithSelector(ILogBond.InvalidNote.selector, 0));
        bond.checkpoint(_note(SANDBOX));
    }

    function test_refusesABountyAboveHalfOrNoBeneficiary() public {
        vm.expectRevert(ILogBond.InvalidBounty.selector);
        new LogBond(IERC20(address(pyusd)), ed, owner, bytes32(0), CONFORMANCE_KEY, DELAY, WINDOW, beneficiary, 5001);
        vm.expectRevert(ILogBond.InvalidBeneficiary.selector);
        new LogBond(IERC20(address(pyusd)), ed, owner, bytes32(0), CONFORMANCE_KEY, DELAY, WINDOW, address(0), 1000);
    }

    /// @dev The real PYUSD freeze on the beneficiary: the slash still goes through, and its share waits for `release`.
    function test_aFrozenBeneficiaryDoesNotBlockTheSlash() public {
        vm.expectRevert(ILogBond.NotReady.selector);
        bond.release();
        _freeze(beneficiary);
        _prove(_note(CONFORMANCE_8), _note(FORK_8));
        assertEq(pyusd.balanceOf(prover), 4e6);
        assertEq(pyusd.balanceOf(address(bond)), 36e6, "the beneficiary's share waits");
        vm.expectRevert();
        bond.release();
        vm.prank(vm.parseJsonAddress(_json(), ".external.pyusdAssetProtector"));
        pyusd.unfreeze(beneficiary);
        bond.release();
        assertEq(pyusd.balanceOf(beneficiary), 36e6);
    }

    function test_twoViewsOfOneSizeSlashTheWholeBond() public {
        bytes memory a = _note(CONFORMANCE_8);
        bytes memory b = _note(FORK_8);
        vm.prank(owner);
        bond.requestWithdrawal(30e6, owner);

        vm.expectEmit(address(bond));
        emit ILogBond.EquivocationProven(
            prover, 8, _case(CONFORMANCE_8).root, _case(FORK_8).root, 40e6, 4e6, keccak256(a), keccak256(b)
        );
        uint256 gasBefore = gasleft();
        _prove(a, b);
        GasBudget.check("logBond_proveEquivocation", gasBefore - gasleft());

        assertEq(pyusd.balanceOf(prover), 4e6, "the bounty");
        assertEq(pyusd.balanceOf(beneficiary), 36e6, "the rest, the pending withdrawal included");
        assertEq(pyusd.balanceOf(address(bond)), 0);
        assertTrue(bond.slashed());
        ILogBond.Equivocation memory e = bond.equivocation();
        assertEq(e.prover, prover);
        assertEq(e.amount, 40e6);
        assertEq(e.bounty, 4e6);
        assertEq(e.size, 8);
        assertEq(e.rootA, _case(CONFORMANCE_8).root);
        assertEq(e.rootB, _case(FORK_8).root);
        assertEq(e.provenAt, block.timestamp);
        assertEq(bond.withdrawal().amount, 0);

        _expectProve(abi.encodeWithSelector(ILogBond.AlreadySlashed.selector), b, a);
        vm.prank(owner);
        vm.expectRevert(ILogBond.AlreadySlashed.selector);
        bond.deposit(1e6);
    }

    function test_eitherOrderAndTheOtherSize() public {
        _prove(_note(FORK_16), _note(CONFORMANCE_16));
        assertEq(bond.equivocation().size, 16);
    }

    function test_refusesWhatIsNotAnEquivocation() public {
        bytes memory notEq = abi.encodeWithSelector(ILogBond.NotEquivocation.selector);
        _expectProve(notEq, _note(CONFORMANCE_8), _note(CONFORMANCE_8));
        _expectProve(notEq, _note(CONFORMANCE_8), _note(FORK_16));
        _expectProve(notEq, _note(CONFORMANCE_8), _note(CONFORMANCE_16));
    }

    function test_refusesAnotherOriginOrKey() public {
        _expectProve(abi.encodeWithSelector(ILogBond.InvalidNote.selector, 1), _note(CONFORMANCE_8), _note(SANDBOX));
        LogBond other = _bond(_case(CONFORMANCE_8).originHash, _case(SANDBOX).root);
        vm.expectRevert(abi.encodeWithSelector(ILogBond.InvalidNote.selector, 0));
        other.proveEquivocation(_note(CONFORMANCE_8), _note(FORK_8));
    }

    /// @dev The deployed log's note carries an ML-DSA-44 line of the same name and the witnesses' cosignatures.
    function test_opensTheDeployedLogsNotes() public {
        LogBond sandbox = _bond(_case(SANDBOX).originHash, SANDBOX_KEY);
        vm.expectRevert(ILogBond.NotEquivocation.selector);
        sandbox.proveEquivocation(_note(SANDBOX), _note(SANDBOX));
    }

    function test_refusesTamperedOrMalformedNotes() public {
        bytes memory good = _note(FORK_8);
        bytes memory tampered = bytes.concat(good);
        // The size line: "...2026-1\n8\n" → "...\n9\n".
        tampered[bytes("log.keelson.finance/conformance/2026-1\n").length] = "9";
        bytes[] memory bad = new bytes[](5);
        bad[0] = tampered;
        bad[1] = _slice(good, 0, good.length - 1);
        bad[2] = bytes("log.keelson.finance/conformance/2026-1\n08\nAAAA\n\n");
        bad[3] = bytes.concat(good, new bytes(8192));
        bad[4] = bytes.concat(_slice(good, 0, _blankLine(good) + 2));
        for (uint256 i; i < bad.length; ++i) {
            _expectProve(abi.encodeWithSelector(ILogBond.InvalidNote.selector, 1), _note(CONFORMANCE_8), bad[i]);
        }
    }

    function test_withdrawalWaitsForTheDelay() public {
        vm.prank(prover);
        vm.expectRevert(ILogBond.NotOwner.selector);
        bond.requestWithdrawal(1, prover);

        vm.startPrank(owner);
        vm.expectRevert(ILogBond.NotReady.selector);
        bond.completeWithdrawal();
        bond.requestWithdrawal(50e6, owner);
        vm.warp(vm.getBlockTimestamp() + DELAY - 1);
        vm.expectRevert(ILogBond.NotReady.selector);
        bond.completeWithdrawal();
        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 before = pyusd.balanceOf(owner);
        bond.completeWithdrawal();
        vm.stopPrank();
        assertEq(pyusd.balanceOf(owner) - before, 40e6, "capped at what the bond holds");
        assertEq(bond.withdrawal().amount, 0);
    }

    /// @dev An unlocked request is not a standing option to leave: it lapses after the completion window.
    function test_anUnlockedWithdrawalLapses() public {
        vm.startPrank(owner);
        bond.requestWithdrawal(10e6, owner);
        vm.warp(vm.getBlockTimestamp() + DELAY + WINDOW + 1);
        vm.expectRevert(ILogBond.NotReady.selector);
        bond.completeWithdrawal();
        vm.stopPrank();
    }

    function test_disagreeingLeafAtTwoSizesSlashesTheWholeBond() public {
        bytes memory a = _note(CONFORMANCE_16);
        bytes memory b = _note(FORK_8);
        ILogBond.Inclusion memory pa = _inclusion(false, 16, 5);
        ILogBond.Inclusion memory pb = _inclusion(true, 8, 5);
        vm.prank(owner);
        bond.requestWithdrawal(30e6, owner);

        vm.expectEmit(address(bond));
        emit ILogBond.EquivocationProven(
            prover, 8, _case(CONFORMANCE_16).root, _case(FORK_8).root, 40e6, 4e6, keccak256(a), keccak256(b)
        );
        uint256 gasBefore = gasleft();
        vm.prank(prover);
        bond.proveInconsistency(a, b, 5, pa, pb);
        GasBudget.check("logBond_proveInconsistency", gasBefore - gasleft());

        assertEq(pyusd.balanceOf(prover), 4e6, "the bounty");
        assertEq(pyusd.balanceOf(beneficiary), 36e6, "the rest, the pending withdrawal included");
        assertTrue(bond.slashed());
        ILogBond.Equivocation memory e = bond.equivocation();
        assertEq(e.size, 8, "the smaller size");
        assertEq(e.rootA, _case(CONFORMANCE_16).root);
        assertEq(e.rootB, _case(FORK_8).root);
        assertEq(bond.withdrawal().amount, 0);

        vm.expectRevert(ILogBond.AlreadySlashed.selector);
        bond.proveInconsistency(a, b, 5, pa, pb);
    }

    /// @dev The first forked entry, with the larger tree on either side.
    function test_inconsistencyEitherOrderAtTheFirstForkedEntry() public {
        ILogBond.Inclusion memory pa = _inclusion(true, 16, 4);
        ILogBond.Inclusion memory pb = _inclusion(false, 8, 4);
        vm.prank(prover);
        bond.proveInconsistency(_note(FORK_16), _note(CONFORMANCE_8), 4, pa, pb);
        assertEq(bond.equivocation().size, 8);
    }

    function test_inconsistencyRefusesASharedLeaf() public {
        ILogBond.Inclusion memory pa = _inclusion(false, 16, 1);
        ILogBond.Inclusion memory pb = _inclusion(true, 8, 1);
        vm.expectRevert(ILogBond.NotInconsistent.selector);
        bond.proveInconsistency(_note(CONFORMANCE_16), _note(FORK_8), 1, pa, pb);
    }

    function test_inconsistencyRefusesAnIndexBeyondTheSmallerTree() public {
        ILogBond.Inclusion memory pa = _inclusion(false, 16, 8);
        ILogBond.Inclusion memory pb = _inclusion(true, 16, 8);
        vm.expectRevert(ILogBond.NotInconsistent.selector);
        bond.proveInconsistency(_note(CONFORMANCE_16), _note(FORK_8), 8, pa, pb);
    }

    function test_inconsistencyRefusesAWrongProof() public {
        ILogBond.Inclusion memory pa = _inclusion(false, 16, 5);
        ILogBond.Inclusion memory pb = _inclusion(true, 8, 5);
        pb.proof[1] = bytes32(uint256(pb.proof[1]) ^ 1);
        vm.expectRevert(ILogBond.NotInconsistent.selector);
        bond.proveInconsistency(_note(CONFORMANCE_16), _note(FORK_8), 5, pa, pb);
        pb.proof[1] = bytes32(uint256(pb.proof[1]) ^ 1);
        pa.leaf = bytes32(uint256(pa.leaf) ^ 1);
        vm.expectRevert(ILogBond.NotInconsistent.selector);
        bond.proveInconsistency(_note(CONFORMANCE_16), _note(FORK_8), 5, pa, pb);
    }

    function test_inconsistencyRefusesANoteOfAnotherKey() public {
        ILogBond.Inclusion memory pa = _inclusion(false, 16, 5);
        ILogBond.Inclusion memory pb = _inclusion(true, 8, 5);
        vm.expectRevert(abi.encodeWithSelector(ILogBond.InvalidNote.selector, 1));
        bond.proveInconsistency(_note(CONFORMANCE_16), _note(SANDBOX), 5, pa, pb);
    }

    /// @dev Two honest checkpoints of different sizes agree on every leaf both hold.
    function testFuzz_consistentCheckpointsNeverSlash(uint8 index) public {
        index = uint8(bound(index, 0, 7));
        ILogBond.Inclusion memory pa = _inclusion(false, 16, index);
        ILogBond.Inclusion memory pb = _inclusion(false, 8, index);
        vm.expectRevert(ILogBond.NotInconsistent.selector);
        bond.proveInconsistency(_note(CONFORMANCE_16), _note(CONFORMANCE_8), index, pa, pb);
    }

    /// @dev The leaf hash and inclusion proof of entry `index` in the conformance tree (or its fork) of `size`, a power
    /// of two; checked against the root the log signed.
    function _inclusion(bool fork, uint64 size, uint64 index) internal view returns (ILogBond.Inclusion memory p) {
        bytes32[] memory level = new bytes32[](size);
        for (uint64 i; i < size; ++i) {
            level[i] = sha256(bytes.concat(bytes1(0x00), _entry(fork, i)));
        }
        p.leaf = level[index];
        uint256 depth;
        for (uint64 n = size; n > 1; n >>= 1) {
            ++depth;
        }
        p.proof = new bytes32[](depth);
        uint64 node = index;
        for (uint256 d; d < depth; ++d) {
            p.proof[d] = level[node ^ 1];
            bytes32[] memory up = new bytes32[](level.length / 2);
            for (uint256 i; i < up.length; ++i) {
                up[i] = RFC6962.hashChildren(level[2 * i], level[2 * i + 1]);
            }
            level = up;
            node >>= 1;
        }
        uint256 vector = fork ? (size == 8 ? FORK_8 : FORK_16) : (size == 8 ? CONFORMANCE_8 : CONFORMANCE_16);
        assertEq(level[0], _case(vector).root, "the signed root");
    }

    /// @dev `conformance.Entry` and the generator's fork, which replaces every entry from 4 on.
    function _entry(bool fork, uint64 i) internal pure returns (bytes memory) {
        if (fork && i >= 4) return bytes(string.concat("keelson conformance fork ", vm.toString(i)));
        return bytes(string.concat("keelson conformance ", vm.toString(i)));
    }

    function _blankLine(bytes memory note) internal pure returns (uint256 i) {
        while (!(note[i] == 0x0a && note[i + 1] == 0x0a)) ++i;
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[from + i];
        }
    }
}
