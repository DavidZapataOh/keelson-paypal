// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../../script/CoverageVector.sol";
import {IKeelsonBondVault} from "../../src/interfaces/IKeelsonBondVault.sol";
import {SlashBase} from "../utils/SlashBase.sol";

/// @notice The packed storage of the vault's bonds and coverages and of the anchor's checkpoints, read slot by slot
/// after a real deposit, lock and anchor on a fork of Arbitrum Sepolia, so a reordered struct cannot pass unnoticed.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract LayoutForkTest is SlashBase {
    uint256 internal constant BONDS_SLOT = 6;
    uint256 internal constant COVERAGES_SLOT = 7;
    uint256 internal constant LATEST_SLOT = 0;

    function test_bondIsTwoSlots() public {
        _locked(WEBAUTHN);
        IKeelsonBondVault.Bond memory b = _bond();
        assertGt(b.locked, 0);
        bytes32 base = keccak256(abi.encode(agentId, BONDS_SLOT));
        uint256 first = uint256(vm.load(address(vault), base));
        uint256 second = uint256(vm.load(address(vault), bytes32(uint256(base) + 1)));
        assertEq(uint128(first), b.free, "free");
        assertEq(first >> 128, b.locked, "locked");
        assertEq(uint128(second), b.queued, "queued");
        assertEq(uint64(second >> 128), b.slashCount, "slashCount");
        assertEq(second >> 192, 0, "unused");
    }

    function test_coverageIsOneSlot() public {
        Vector memory v = _locked(DEGRADED);
        IKeelsonBondVault.CoverageState memory c = vault.coverages(v.coverage.coverageId);
        bytes32 base = keccak256(abi.encode(v.coverage.coverageId, COVERAGES_SLOT));
        uint256 word = uint256(vm.load(address(vault), base));
        assertEq(uint96(word), c.amount, "amount");
        assertEq(uint64(word >> 96), c.agentId, "agentId");
        assertEq(uint40(word >> 160), c.releaseAfter, "releaseAfter");
        assertEq(uint8(word >> 200), uint8(c.status), "status");
        assertEq(uint8(word >> 208) == 1, c.degraded, "degraded");
        assertEq(uint8(word >> 216), c.pendingSlashes, "pendingSlashes");
        assertEq(vm.load(address(vault), bytes32(uint256(base) + 1)), 0, "second slot");
    }

    function test_anchorIsOneSlot() public view {
        address anchor = address(vault.anchor());
        bytes32 origin = vault.logOrigin();
        (uint64 size,, uint40 anchoredAt) = vault.anchor().latest(origin);
        assertGt(size, 0);
        uint256 word = uint256(vm.load(anchor, keccak256(abi.encode(origin, LATEST_SLOT))));
        assertEq(uint64(word), size, "size");
        assertEq(uint40(word >> 64), anchoredAt, "anchoredAt");
        assertEq(word >> 104, 0, "unused");
    }
}
