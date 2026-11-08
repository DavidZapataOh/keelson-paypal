// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract Erc20Token is ERC20 {
    constructor() ERC20("Token", "TKN") {}
}
