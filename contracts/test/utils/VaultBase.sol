// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployBondVault} from "../../script/DeployBondVault.s.sol";
import {KeelsonBondVault} from "../../src/KeelsonBondVault.sol";
import {IKeelsonBondVault} from "../../src/interfaces/IKeelsonBondVault.sol";
import {ForkTest} from "./Fork.sol";
import {IPyusd} from "./IPyusd.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The vault deployed by its script on a fork of Arbitrum Sepolia, after the demo operator was registered in the
/// ERC-8004 Identity registry, with the real `VerdictVerifier` (both legs' signers registered), `CheckpointAnchor`,
/// PYUSD and the funders' faucet balances.
abstract contract VaultBase is ForkTest {
    using stdJson for string;

    uint256 internal constant FORK_BLOCK = 327_231_200;
    string internal constant VAULT = "KeelsonBondVaultPreview";

    DeployBondVault internal deployScript;
    KeelsonBondVault internal vault;
    IPyusd internal pyusd;
    uint256 internal agentId;
    address internal operator;
    uint256 internal operatorKey;
    uint256 internal saltCounter;

    function setUp() public virtual {
        vm.createSelectFork(vm.envString("ARBITRUM_SEPOLIA_RPC_URL"), FORK_BLOCK);
        pyusd = _pyusd();
        agentId = _demoAgentId();
        (operator, operatorKey) = _operator();
        assertEq(_identity().ownerOf(agentId), operator, "demo agent owner");

        deployScript = new DeployBondVault();
        vault = deployScript.run(VAULT);
        vm.warp(vm.getBlockTimestamp() + _timelock().getMinDelay());
        deployScript.wire(VAULT);
    }

    function _timelock() internal view returns (TimelockController) {
        return TimelockController(payable(_json().readAddress(".contracts.TimelockController")));
    }

    /// @dev Scheduled by the proposer (the deployer EOA) and executed once the delay passed.
    function _viaTimelock(address to, bytes memory data) internal {
        TimelockController timelock = _timelock();
        bytes32 salt = bytes32(++saltCounter);
        uint256 delay = timelock.getMinDelay();
        vm.prank(_json().readAddress(".governance.proposer"));
        timelock.schedule(to, 0, data, bytes32(0), salt, delay);
        vm.warp(vm.getBlockTimestamp() + delay);
        timelock.execute(to, 0, data, bytes32(0), salt);
    }

    /// @dev A funder's real faucet PYUSD, deposited for `agentId` through EIP-3009.
    function _deposit(uint256 funder, uint256 amount, bytes32 salt) internal {
        (address from, uint256 pk) = _funder(funder);
        bytes32 nonce = keccak256(abi.encode(agentId, salt));
        bytes memory sig = _signReceiveWithAuthorization(pk, address(vault), amount, 0, type(uint256).max, nonce);
        vault.depositWithAuthorization(agentId, from, amount, 0, type(uint256).max, salt, sig);
    }

    function _signVault(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _bond() internal view returns (IKeelsonBondVault.Bond memory) {
        return vault.bonds(agentId);
    }
}
