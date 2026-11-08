// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {SymbolicSetup} from "./SymbolicSetup.sol";

/// @notice Bounded symbolic checks of the warranty reserve.
contract ReserveSymbolicTest is SymbolicSetup {
    /// @notice RSV1 and LIA: a warranty pays only on both signatures for a verdict naming Keelson liable, once per
    /// dispute, and a slash cannot settle that dispute afterwards.
    function check_warrantySingleUse(uint8 liable, uint96 amount, bool lone) public {
        bytes32 disputeId = keccak256("warranty");
        KeelsonTypes.Verdict memory v = _verdict(disputeId, COVERAGE, amount, liable);
        bytes32 digest = _digest(v);
        bool paid = _payWarranty(v, lone ? _signWith(TDX_KEY, digest) : _sign2of2(digest));
        if (!paid) return;
        assert(liable == KEELSON && !lone && reserve.settled(disputeId));

        KeelsonTypes.Verdict memory again = _verdict(disputeId, COVERAGE, 1e6, KEELSON);
        assert(!_payWarranty(again, _sign2of2(_digest(again))));
        KeelsonTypes.Verdict memory slash = _verdict(disputeId, COVERAGE, 1e6, OPERATOR);
        assert(!_slash(slash, _sign2of2(_digest(slash))));
    }

    /// @notice RSV2: shares are redeemed only inside the owner's window after its cooldown.
    function check_reserveCooldown(uint40 requestAt, uint40 redeemAt) public {
        address staker = STAKER;
        assertTrue(token.transfer(staker, 10e6));
        vm.startPrank(staker);
        token.approve(address(reserve), 10e6);
        uint256 shares = reserve.deposit(10e6, staker);
        vm.assume(requestAt > start && redeemAt >= requestAt);
        vm.warp(requestAt);
        reserve.requestCooldown();
        vm.warp(redeemAt);
        (bool ok,) = address(reserve).call(abi.encodeCall(reserve.redeem, (shares, staker, staker)));
        vm.stopPrank();
        if (ok) {
            assert(uint256(redeemAt) >= uint256(requestAt) + COOLDOWN);
            assert(uint256(redeemAt) <= uint256(requestAt) + COOLDOWN + UNSTAKE_WINDOW);
        }
    }
}
