// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Sha384} from "./Sha384.sol";

/// @notice One runtime event that dstack extends into RTMR3. Its event type is always `0x08000001`.
struct RuntimeEvent {
    string name;
    bytes payload;
}

/// @title DstackEvents
/// @notice Replays dstack's RTMR3 event log and derives the measurement of a dstack CVM from it.
/// @dev dstack extends RTMR3 with `SHA-384(le32(0x08000001) ‖ ":" ‖ name ‖ ":" ‖ payload)` for each runtime event,
/// starting from 48 zero bytes.
library DstackEvents {
    /// @dev `0x08000001` little-endian, then `:`.
    bytes5 private constant EVENT_PREFIX = 0x010000083a;

    /// @notice The log has no event with this name.
    error MissingEvent(string name);
    /// @notice The event's payload has the wrong length.
    error BadEventPayload(string name);

    /// @notice RTMR3 after extending it with `events`, in order.
    function replay(RuntimeEvent[] calldata events) internal pure returns (bytes memory rtmr3) {
        rtmr3 = new bytes(48);
        for (uint256 i; i < events.length; ++i) {
            bytes memory digest = Sha384.hash(bytes.concat(EVENT_PREFIX, bytes(events[i].name), ":", events[i].payload));
            rtmr3 = Sha384.hash(bytes.concat(rtmr3, digest));
        }
    }

    /// @notice `sha256(mrtd ‖ rtmr0 ‖ rtmr1 ‖ rtmr2 ‖ appId ‖ composeHash ‖ osImageHash)`, the payloads taken from the
    /// first `app-id`, `compose-hash` and `os-image-hash` events. RTMR3 is left out: it extends the per-CVM instance
    /// id, so callers replay `events` against it instead.
    function tdxMeasurement(
        bytes memory mrtd,
        bytes memory rtmr0,
        bytes memory rtmr1,
        bytes memory rtmr2,
        RuntimeEvent[] calldata events
    ) internal pure returns (bytes32) {
        return sha256(
            bytes.concat(
                mrtd,
                rtmr0,
                rtmr1,
                rtmr2,
                _payload(events, "app-id", 20),
                _payload(events, "compose-hash", 32),
                _payload(events, "os-image-hash", 32)
            )
        );
    }

    function _payload(RuntimeEvent[] calldata events, string memory name, uint256 length)
        private
        pure
        returns (bytes calldata payload)
    {
        bytes32 nameHash = keccak256(bytes(name));
        uint256 i = 0;
        while (i < events.length && keccak256(bytes(events[i].name)) != nameHash) ++i;
        if (i == events.length) revert MissingEvent(name);
        payload = events[i].payload;
        if (payload.length != length) revert BadEventPayload(name);
    }
}
