// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DstackEvents, RuntimeEvent} from "../src/libraries/DstackEvents.sol";
import {Test} from "forge-std/Test.sol";

contract DstackEventsHarness {
    function replay(RuntimeEvent[] calldata events) external pure returns (bytes memory) {
        return DstackEvents.replay(events);
    }

    function tdxMeasurement(
        bytes memory mrtd,
        bytes memory rtmr0,
        bytes memory rtmr1,
        bytes memory rtmr2,
        RuntimeEvent[] calldata events
    ) external pure returns (bytes32) {
        return DstackEvents.tdxMeasurement(mrtd, rtmr0, rtmr1, rtmr2, events);
    }
}

/// @notice The live leg A's RTMR3 event log and registers, captured from the API with the measurement it verified.
contract DstackEventsTest is Test {
    DstackEventsHarness internal harness;
    string internal json;

    function setUp() public {
        harness = new DstackEventsHarness();
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/tdx-events.json"));
    }

    /// @dev Element by element: `vm.parseJson` would decode an empty payload `0x` as a string.
    function _events() internal view returns (RuntimeEvent[] memory events) {
        uint256 count;
        while (vm.keyExistsJson(json, string.concat(".events[", vm.toString(count), "]"))) ++count;
        events = new RuntimeEvent[](count);
        for (uint256 i; i < count; ++i) {
            string memory path = string.concat(".events[", vm.toString(i), "]");
            assertEq(vm.parseJsonUint(json, string.concat(path, ".eventType")), 0x08000001, "runtime event type");
            events[i] = RuntimeEvent(
                vm.parseJsonString(json, string.concat(path, ".name")),
                vm.parseJsonBytes(json, string.concat(path, ".payload"))
            );
        }
    }

    function _measure(RuntimeEvent[] memory events) internal view returns (bytes32) {
        return harness.tdxMeasurement(
            vm.parseJsonBytes(json, ".mrtd"),
            vm.parseJsonBytes(json, ".rtmr0"),
            vm.parseJsonBytes(json, ".rtmr1"),
            vm.parseJsonBytes(json, ".rtmr2"),
            events
        );
    }

    function test_ReplayEqualsQuoteRtmr3() public {
        RuntimeEvent[] memory events = _events();
        assertEq(events.length, 11);
        uint256 before = gasleft();
        bytes memory rtmr3 = harness.replay(events);
        emit log_named_uint("rtmr3 replay gas, 11 events", before - gasleft());
        assertEq(rtmr3, vm.parseJsonBytes(json, ".rtmr3"));
    }

    function test_MeasurementEqualsVerifiedId() public view {
        assertEq(_measure(_events()), vm.parseJsonBytes32(json, ".measurement"));
    }

    function test_ChangedComposeHashChangesReplay() public view {
        RuntimeEvent[] memory events = _events();
        assertEq(events[2].name, "compose-hash");
        events[2].payload[31] ^= 0x01;
        assertNotEq(harness.replay(events), vm.parseJsonBytes(json, ".rtmr3"));
    }

    function test_RevertWhen_NoOsImageHash() public {
        RuntimeEvent[] memory events = _events();
        RuntimeEvent[] memory without = new RuntimeEvent[](events.length - 1);
        uint256 j;
        for (uint256 i; i < events.length; ++i) {
            if (keccak256(bytes(events[i].name)) != keccak256("os-image-hash")) without[j++] = events[i];
        }
        vm.expectRevert(abi.encodeWithSelector(DstackEvents.MissingEvent.selector, "os-image-hash"));
        _measure(without);
    }

    function test_RevertWhen_ShortAppId() public {
        RuntimeEvent[] memory events = _events();
        assertEq(events[1].name, "app-id");
        events[1].payload = hex"00";
        vm.expectRevert(abi.encodeWithSelector(DstackEvents.BadEventPayload.selector, "app-id"));
        _measure(events);
    }
}
