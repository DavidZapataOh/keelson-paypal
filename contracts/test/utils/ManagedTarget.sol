// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";

/// @notice Test fixture: one `restricted` function per Keelson role.
contract ManagedTarget is AccessManaged {
    bool public paused;
    uint256 public window;
    address public signer;

    constructor(address manager) AccessManaged(manager) {}

    function pause() external restricted {
        paused = true;
    }

    function setWindow(uint256 window_) external restricted {
        window = window_;
    }

    function setSigner(address signer_) external restricted {
        signer = signer_;
    }
}
