// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IPyusd} from "./IPyusd.sol";

/// @notice Test fixture that pulls PYUSD with `receiveWithAuthorization`, as the payee must.
contract AuthorizedReceiver {
    IPyusd public immutable pyusd;

    constructor(IPyusd pyusd_) {
        pyusd = pyusd_;
    }

    function pull(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        pyusd.receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, signature);
    }

    function pull(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        pyusd.receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, v, r, s);
    }
}
