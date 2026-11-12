// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title TdxOutput
/// @notice Reads a TD 1.0 report out of the `Output` Automata's DCAP verifier returns for a v4 TDX quote.
/// @dev `Output` is `uint16 quoteVersion ‖ uint16 quoteBodyType ‖ uint8 tcbStatus ‖ bytes6 fmspc ‖ quoteBody ‖
/// advisories`, big-endian; `quoteBody` is the 584-byte TD10 report body (Intel TDX DCAP Quoting Library API, A.3.2)
/// and `advisories` is `abi.encode(string[])`, present only when Intel lists advisories.
library TdxOutput {
    struct Td10 {
        uint8 tcbStatus;
        bool hasAdvisories;
        /// @dev `TDATTRIBUTES.DEBUG`: the host can read and change the TD's memory.
        bool debug;
        /// @dev `TDATTRIBUTES` as the report stores it (little-endian).
        bytes8 tdAttributes;
        /// @dev Whether `MROWNER` and `MROWNERCONFIG`, which the host sets at launch and MRTD does not cover, are zero.
        bool ownerRegistersZero;
        bytes mrtd;
        bytes rtmr0;
        bytes rtmr1;
        bytes rtmr2;
        bytes rtmr3;
        bytes reportData;
    }

    /// @dev Where the report body starts in `Output`.
    uint256 private constant BODY = 11;
    uint256 private constant TD10_LENGTH = 584;

    /// @notice The output is not a v4 quote with a TD 1.0 report body.
    error QuoteNotTdx();

    function parse(bytes memory output) internal pure returns (Td10 memory td) {
        if (output.length < BODY + TD10_LENGTH) revert QuoteNotTdx();
        // quoteVersion 4, quoteBodyType 2 (TD10), both big-endian.
        if (output[0] != 0x00 || output[1] != 0x04 || output[2] != 0x00 || output[3] != 0x02) revert QuoteNotTdx();
        td.tcbStatus = uint8(output[4]);
        td.hasAdvisories = output.length > BODY + TD10_LENGTH;
        // TDATTRIBUTES is little-endian; DEBUG is bit 0.
        td.debug = uint8(output[BODY + 120]) & 1 == 1;
        // The slice is exactly 8 bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        td.tdAttributes = bytes8(_slice(output, BODY + 120, 8));
        td.ownerRegistersZero = keccak256(_slice(output, BODY + 232, 96)) == keccak256(new bytes(96));
        td.mrtd = _slice(output, BODY + 136, 48);
        td.rtmr0 = _slice(output, BODY + 328, 48);
        td.rtmr1 = _slice(output, BODY + 376, 48);
        td.rtmr2 = _slice(output, BODY + 424, 48);
        td.rtmr3 = _slice(output, BODY + 472, 48);
        td.reportData = _slice(output, BODY + 520, 64);
    }

    function _slice(bytes memory data, uint256 start, uint256 length) private pure returns (bytes memory out) {
        out = new bytes(length);
        assembly ("memory-safe") {
            mcopy(add(out, 0x20), add(add(data, 0x20), start), length)
        }
    }
}
