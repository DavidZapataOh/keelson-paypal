// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {VerdictVerifier} from "../src/VerdictVerifier.sol";
import {IAutomataDcapAttestation} from "../src/interfaces/IAutomataDcapAttestation.sol";
import {INitroValidator} from "../src/interfaces/INitroValidator.sol";
import {IVerdictVerifier} from "../src/interfaces/IVerdictVerifier.sol";
import {RuntimeEvent} from "../src/libraries/DstackEvents.sol";
import {TdxOutput} from "../src/libraries/TdxOutput.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

contract TdxOutputHarness {
    function parse(bytes memory output) external pure returns (TdxOutput.Td10 memory) {
        return TdxOutput.parse(output);
    }
}

/// @notice Exposes the TDX registration after Automata's verification, so its policy checks run without a quote
/// verified on-chain. The binding check that follows them reads `ArbSys`, which only the live chain has.
contract VerdictVerifierTdxHarness is VerdictVerifier {
    /// @dev The verifiers must have code; the policy checks under test never call them.
    constructor(bytes32[] memory measurements)
        VerdictVerifier(
            address(1),
            address(2),
            bytes32(0),
            measurements,
            IAutomataDcapAttestation(msg.sender),
            INitroValidator(msg.sender)
        )
    {}

    function registerTdx(
        bytes memory output,
        RuntimeEvent[] calldata events,
        SignerBinding calldata binding,
        uint256 blockNumber
    ) external {
        _registerTdx(output, events, binding, blockNumber);
    }
}

/// @notice Automata's `Output` for leg A's live quote, serialized as Automata's `QuoteVerifierBase.serializeOutput`
/// does from the quote's TD10 report body.
contract TdxOutputTest is Test {
    using stdJson for string;

    /// @dev The quote's FMSPC, from its PCK certificate.
    bytes6 internal constant FMSPC = 0x20a06f000000;

    string internal json;
    bytes internal body;
    TdxOutputHarness internal harness;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/tdx-events.json"));
        bytes memory quote = json.readBytes(".quote");
        body = new bytes(584);
        for (uint256 i; i < 584; ++i) {
            body[i] = quote[48 + i];
        }
        harness = new TdxOutputHarness();
    }

    function _output(uint16 version, uint16 bodyType, uint8 tcbStatus, bytes memory advisories)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(version, bodyType, tcbStatus, FMSPC, body, advisories);
    }

    function _events() internal view returns (RuntimeEvent[] memory events) {
        uint256 count;
        while (vm.keyExistsJson(json, string.concat(".events[", vm.toString(count), "]"))) ++count;
        events = new RuntimeEvent[](count);
        for (uint256 i; i < count; ++i) {
            string memory path = string.concat(".events[", vm.toString(i), "]");
            events[i] = RuntimeEvent(
                vm.parseJsonString(json, string.concat(path, ".name")),
                vm.parseJsonBytes(json, string.concat(path, ".payload"))
            );
        }
    }

    function test_ParsesTheQuoteRegisters() public view {
        TdxOutput.Td10 memory td = harness.parse(_output(4, 2, 0, ""));
        assertEq(td.tcbStatus, 0);
        assertFalse(td.hasAdvisories);
        assertFalse(td.debug);
        assertEq(td.mrtd, json.readBytes(".mrtd"));
        assertEq(td.rtmr0, json.readBytes(".rtmr0"));
        assertEq(td.rtmr1, json.readBytes(".rtmr1"));
        assertEq(td.rtmr2, json.readBytes(".rtmr2"));
        assertEq(td.rtmr3, json.readBytes(".rtmr3"));
        assertEq(td.reportData, json.readBytes(".reportData"));
    }

    function test_AdvisoriesAreAppended() public view {
        string[] memory ids = new string[](1);
        ids[0] = "INTEL-SA-00837";
        assertTrue(harness.parse(_output(4, 2, 1, abi.encode(ids))).hasAdvisories);
    }

    function test_RevertWhen_NotTd10() public {
        vm.expectRevert(TdxOutput.QuoteNotTdx.selector);
        harness.parse(_output(3, 1, 0, ""));
        vm.expectRevert(TdxOutput.QuoteNotTdx.selector);
        harness.parse(_output(4, 1, 0, ""));
        vm.expectRevert(TdxOutput.QuoteNotTdx.selector);
        harness.parse(new bytes(594));
    }

    function _registrar() internal returns (VerdictVerifierTdxHarness) {
        bytes32[] memory measurements = new bytes32[](1);
        measurements[0] = json.readBytes32(".measurement");
        return new VerdictVerifierTdxHarness(measurements);
    }

    function _binding() internal view returns (IVerdictVerifier.SignerBinding memory b) {
        b.teeKind = 1;
        b.signer = json.readAddress(".signer");
    }

    function test_RevertWhen_TcbStatusNotAccepted() public {
        VerdictVerifierTdxHarness registrar = _registrar();
        RuntimeEvent[] memory events = _events();
        IVerdictVerifier.SignerBinding memory b = _binding();
        vm.expectRevert(abi.encodeWithSelector(IVerdictVerifier.TcbStatusNotAccepted.selector, 4));
        registrar.registerTdx(_output(4, 2, 4, ""), events, b, 0);
        vm.expectRevert(abi.encodeWithSelector(IVerdictVerifier.TcbStatusNotAccepted.selector, 1));
        registrar.registerTdx(_output(4, 2, 1, ""), events, b, 0);
    }

    function test_RevertWhen_DebugTd() public {
        VerdictVerifierTdxHarness registrar = _registrar();
        body[120] |= 0x01;
        bytes memory output = _output(4, 2, 0, "");
        RuntimeEvent[] memory events = _events();
        IVerdictVerifier.SignerBinding memory b = _binding();
        vm.expectRevert(IVerdictVerifier.TdDebug.selector);
        registrar.registerTdx(output, events, b, 0);
    }

    function test_RevertWhen_EventLogDoesNotReplay() public {
        VerdictVerifierTdxHarness registrar = _registrar();
        RuntimeEvent[] memory events = _events();
        events[2].payload[0] ^= 0x01;
        IVerdictVerifier.SignerBinding memory b = _binding();
        vm.expectRevert(IVerdictVerifier.Rtmr3Mismatch.selector);
        registrar.registerTdx(_output(4, 2, 0, ""), events, b, 0);
    }

    /// @dev Past the TCB, debug and RTMR3 checks the next step reads `ArbSys`, which has no code off Arbitrum.
    function test_AcceptedQuoteReachesTheBindingCheck() public {
        VerdictVerifierTdxHarness registrar = _registrar();
        RuntimeEvent[] memory events = _events();
        IVerdictVerifier.SignerBinding memory b = _binding();
        string[] memory ids = new string[](1);
        ids[0] = "INTEL-SA-00837";
        bytes memory hardened = _output(4, 2, 1, abi.encode(ids));
        vm.expectRevert(IVerdictVerifier.BindingMismatch.selector);
        registrar.registerTdx(hardened, events, b, 0);
    }
}
