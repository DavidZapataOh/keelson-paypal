// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {AuthorizedReceiver} from "./utils/AuthorizedReceiver.sol";
import {ForkTest} from "./utils/Fork.sol";
import {IPyusd} from "./utils/IPyusd.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The EIP-3009, EIP-2612 and freeze paths of the real PYUSD on every chain's pinned fork.
contract PyusdForkTest is ForkTest {
    using stdJson for string;

    uint256 internal constant VALUE = 1e6;

    function setUp() public {
        _forkAll();
    }

    /// @dev Funder 0 on the testnets; on Arbitrum One a fresh key funded from the pinned holder.
    function _payer() internal returns (address account, uint256 pk) {
        if (vm.getChainId() == 42161) {
            (account, pk) = makeAddrAndKey("payer");
            _fundFromHolder(account, 10 * VALUE);
        } else {
            (account, pk) = _funder(0);
        }
        assertGe(_pyusd().balanceOf(account), VALUE, _name());
    }

    function _name() internal view returns (string memory) {
        return vm.toString(vm.getChainId());
    }

    function _receiver() internal returns (AuthorizedReceiver) {
        return new AuthorizedReceiver(_pyusd());
    }

    function test_PyusdIdentity() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            _select(CHAIN_IDS[i]);
            IPyusd pyusd = _pyusd();
            assertEq(address(pyusd), _json().readAddress(".external.pyusd"), _name());
            assertEq(pyusd.symbol(), "PYUSD", _name());
            assertEq(pyusd.decimals(), 6, _name());
        }
    }

    function test_ReceiveWithAuthorizationBytes() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            _select(CHAIN_IDS[i]);
            IPyusd pyusd = _pyusd();
            (address from, uint256 pk) = _payer();
            AuthorizedReceiver receiver = _receiver();
            bytes32 nonce = keccak256(abi.encode("bytes", vm.getChainId()));
            uint256 validBefore = vm.getBlockTimestamp() + 1 hours;
            bytes memory sig = _signReceiveWithAuthorization(pk, address(receiver), VALUE, 0, validBefore, nonce);
            uint256 before = pyusd.balanceOf(from);

            receiver.pull(from, VALUE, 0, validBefore, nonce, sig);

            assertEq(pyusd.balanceOf(from), before - VALUE, _name());
            assertEq(pyusd.balanceOf(address(receiver)), VALUE, _name());
            assertTrue(pyusd.authorizationState(from, nonce), _name());
        }
    }

    function test_ReceiveWithAuthorizationVrs() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            _select(CHAIN_IDS[i]);
            IPyusd pyusd = _pyusd();
            (address from, uint256 pk) = _payer();
            AuthorizedReceiver receiver = _receiver();
            bytes32 nonce = keccak256(abi.encode("vrs", vm.getChainId()));
            uint256 validBefore = vm.getBlockTimestamp() + 1 hours;
            bytes memory sig = _signReceiveWithAuthorization(pk, address(receiver), VALUE, 0, validBefore, nonce);
            bytes32 r;
            bytes32 s;
            assembly ("memory-safe") {
                r := mload(add(sig, 0x20))
                s := mload(add(sig, 0x40))
            }
            uint8 v = uint8(sig[64]);
            uint256 before = pyusd.balanceOf(from);

            receiver.pull(from, VALUE, 0, validBefore, nonce, v, r, s);

            assertEq(pyusd.balanceOf(from), before - VALUE, _name());
            assertEq(pyusd.balanceOf(address(receiver)), VALUE, _name());
            assertTrue(pyusd.authorizationState(from, nonce), _name());
        }
    }

    /// @dev PYUSD does not revert on a used nonce: it emits `AuthorizationAlreadyUsed` and moves nothing,
    /// so integrators must not infer a transfer from a successful call.
    function test_ReplayedAuthorizationMovesNothing() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            _select(CHAIN_IDS[i]);
            IPyusd pyusd = _pyusd();
            (address from, uint256 pk) = _payer();
            AuthorizedReceiver receiver = _receiver();
            bytes32 nonce = keccak256(abi.encode("replay", vm.getChainId()));
            uint256 validBefore = vm.getBlockTimestamp() + 1 hours;
            bytes memory sig = _signReceiveWithAuthorization(pk, address(receiver), VALUE, 0, validBefore, nonce);
            receiver.pull(from, VALUE, 0, validBefore, nonce, sig);
            uint256 payerAfterFirst = pyusd.balanceOf(from);

            vm.expectEmit(address(pyusd));
            emit IPyusd.AuthorizationAlreadyUsed(from, nonce);
            receiver.pull(from, VALUE, 0, validBefore, nonce, sig);

            assertEq(pyusd.balanceOf(from), payerAfterFirst, _name());
            assertEq(pyusd.balanceOf(address(receiver)), VALUE, _name());
        }
    }

    function test_RevertWhen_CallerIsNotTo() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            _select(CHAIN_IDS[i]);
            IPyusd pyusd = _pyusd();
            (address from, uint256 pk) = _payer();
            AuthorizedReceiver receiver = _receiver();
            bytes32 nonce = keccak256(abi.encode("caller", vm.getChainId()));
            uint256 validBefore = vm.getBlockTimestamp() + 1 hours;
            bytes memory sig = _signReceiveWithAuthorization(pk, address(receiver), VALUE, 0, validBefore, nonce);

            vm.prank(makeAddr("third party"));
            vm.expectRevert(IPyusd.CallerMustBePayee.selector);
            pyusd.receiveWithAuthorization(from, address(receiver), VALUE, 0, validBefore, nonce, sig);
        }
    }

    function test_RevertWhen_AuthorizationExpired() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            _select(CHAIN_IDS[i]);
            (address from, uint256 pk) = _payer();
            AuthorizedReceiver receiver = _receiver();
            bytes32 nonce = keccak256(abi.encode("expired", vm.getChainId()));
            uint256 validBefore = vm.getBlockTimestamp() + 1 hours;
            bytes memory sig = _signReceiveWithAuthorization(pk, address(receiver), VALUE, 0, validBefore, nonce);
            vm.warp(validBefore);

            vm.expectRevert(IPyusd.AuthorizationExpired.selector);
            receiver.pull(from, VALUE, 0, validBefore, nonce, sig);
        }
    }

    function test_PermitBytes() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            _select(CHAIN_IDS[i]);
            IPyusd pyusd = _pyusd();
            (address owner, uint256 pk) = _payer();
            address spender = makeAddr("spender");
            uint256 nonce = pyusd.nonces(owner);
            uint256 deadline = vm.getBlockTimestamp() + 1 hours;
            bytes memory sig = _signPermit(pk, spender, VALUE, deadline);

            pyusd.permit(owner, spender, VALUE, deadline, sig);

            assertEq(pyusd.allowance(owner, spender), VALUE, _name());
            assertEq(pyusd.nonces(owner), nonce + 1, _name());
        }
    }

    function test_FrozenReceiverCannotReceiveOrSend() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            _select(CHAIN_IDS[i]);
            IPyusd pyusd = _pyusd();
            (address from,) = _payer();
            address receiver = makeAddr("receiver");
            vm.prank(from);
            assertTrue(pyusd.transfer(receiver, VALUE));

            _freeze(receiver);

            assertTrue(pyusd.isFrozen(receiver), _name());
            vm.prank(from);
            vm.expectRevert(IPyusd.AddressFrozen.selector);
            pyusd.transfer(receiver, VALUE);
            vm.prank(receiver);
            vm.expectRevert(IPyusd.AddressFrozen.selector);
            pyusd.transfer(from, VALUE);
        }
    }
}
