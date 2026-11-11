// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployLogBond} from "../script/DeployLogBond.s.sol";
import {LogBond} from "../src/LogBond.sol";
import {IEd25519Verifier} from "../src/interfaces/IEd25519Verifier.sol";
import {ILogBond} from "../src/interfaces/ILogBond.sol";
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

    IPyusd internal pyusd;
    IEd25519Verifier internal ed;
    LogBond internal bond;
    address internal owner = makeAddr("owner");
    address internal prover = makeAddr("prover");

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
        return new LogBond(IERC20(address(pyusd)), ed, owner, origin, key, DELAY);
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
        vm.setEnv("LOG_BOND_NAME", "LogBondConformance");
        vm.setEnv("LOG_BOND_ORIGIN", "log.keelson.finance/conformance/2026-1");
        vm.setEnv("LOG_BOND_KEY", vm.toString(CONFORMANCE_KEY));
        vm.setEnv("LOG_BOND_OWNER", vm.toString(owner));
        vm.setEnv("LOG_BOND_NOTE", vm.toString(_note(CONFORMANCE_16)));
        DeployLogBond script = new DeployLogBond();
        LogBond deployed = script.run();
        assertEq(address(deployed), script.predict("LogBondConformance"));
        assertEq(deployed.owner(), owner);
        assertEq(deployed.withdrawalDelay(), 7 days);
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

    function test_twoViewsOfOneSizeTakeTheWholeBond() public {
        bytes memory a = _note(CONFORMANCE_8);
        bytes memory b = _note(FORK_8);
        vm.prank(owner);
        bond.requestWithdrawal(30e6, owner);

        vm.expectEmit(address(bond));
        emit ILogBond.EquivocationProven(
            prover, 8, _case(CONFORMANCE_8).root, _case(FORK_8).root, 40e6, keccak256(a), keccak256(b)
        );
        uint256 gasBefore = gasleft();
        _prove(a, b);
        GasBudget.check("logBond_proveEquivocation", gasBefore - gasleft());

        assertEq(pyusd.balanceOf(prover), 40e6, "the pending withdrawal was slashed too");
        assertEq(pyusd.balanceOf(address(bond)), 0);
        assertTrue(bond.slashed());
        ILogBond.Equivocation memory e = bond.equivocation();
        assertEq(e.prover, prover);
        assertEq(e.amount, 40e6);
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
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert(ILogBond.NotReady.selector);
        bond.completeWithdrawal();
        vm.warp(block.timestamp + 1);
        uint256 before = pyusd.balanceOf(owner);
        bond.completeWithdrawal();
        vm.stopPrank();
        assertEq(pyusd.balanceOf(owner) - before, 40e6, "capped at what the bond holds");
        assertEq(bond.withdrawal().amount, 0);
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
