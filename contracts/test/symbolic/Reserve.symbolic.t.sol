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

    /// @notice RSV2: requested shares are fulfilled only once the cooldown has passed since the request, and nothing is
    /// claimable before.
    function check_reserveCooldown(uint40 requestAt, uint40 fulfilAt) public {
        address staker = STAKER;
        assertTrue(token.transfer(staker, 10e6));
        vm.startPrank(staker);
        token.approve(address(reserve), 10e6);
        uint256 shares = reserve.deposit(10e6, staker);
        vm.assume(requestAt > start && fulfilAt >= requestAt);
        vm.warp(requestAt);
        reserve.requestRedeem(shares, staker, staker);
        assert(reserve.maxRedeem(staker) == 0);
        vm.warp(fulfilAt);
        (bool ok,) = address(reserve).call(abi.encodeCall(reserve.fulfillRedeem, (staker)));
        vm.stopPrank();
        if (ok) {
            assert(uint256(fulfilAt) >= uint256(requestAt) + COOLDOWN);
            assert(reserve.maxRedeem(staker) == shares);
        } else {
            assert(reserve.maxRedeem(staker) == 0);
        }
    }
}
