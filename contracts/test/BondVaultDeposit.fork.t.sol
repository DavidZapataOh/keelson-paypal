// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {IPyusd} from "./utils/IPyusd.sol";
import {VaultBase} from "./utils/VaultBase.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";

/// @notice Gasless deposits of real faucet PYUSD on a fork of Arbitrum Sepolia.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract BondVaultDepositForkTest is VaultBase {
    uint256 internal constant AMOUNT = 5e6;

    function _authorization(uint256 validAfter, uint256 validBefore, bytes32 salt)
        internal
        view
        returns (address from, bytes memory sig)
    {
        uint256 pk;
        (from, pk) = _funder(0);
        sig = _signReceiveWithAuthorization(
            pk, address(vault), AMOUNT, validAfter, validBefore, keccak256(abi.encode(agentId, salt))
        );
    }

    function test_depositWithAuthorization() public {
        (address from, bytes memory sig) = _authorization(0, type(uint256).max, "a");
        uint256 before = pyusd.balanceOf(address(vault));
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.BondDeposited(agentId, from, AMOUNT);
        vm.prank(makeAddr("relayer"));
        vault.depositWithAuthorization(agentId, from, AMOUNT, 0, type(uint256).max, "a", sig);
        emit log_named_uint(
            "depositWithAuthorization execution, first deposit",
            _executionGas(
                abi.encodeCall(vault.depositWithAuthorization, (agentId, from, AMOUNT, 0, type(uint256).max, "a", sig))
            )
        );
        (address from2, bytes memory sig2) = _authorization(0, type(uint256).max, "b");
        vault.depositWithAuthorization(agentId, from2, AMOUNT, 0, type(uint256).max, "b", sig2);
        emit log_named_uint(
            "depositWithAuthorization execution, later deposit",
            _executionGas(
                abi.encodeCall(
                    vault.depositWithAuthorization, (agentId, from2, AMOUNT, 0, type(uint256).max, "b", sig2)
                )
            )
        );
        assertEq(_bond().free, 2 * AMOUNT);
        assertEq(pyusd.balanceOf(address(vault)) - before, 2 * AMOUNT);
        assertTrue(pyusd.authorizationState(from, keccak256(abi.encode(agentId, bytes32("a")))));
    }

    function test_depositWithAuthorization_revertsForOtherAgent() public {
        (address from, bytes memory sig) = _authorization(0, type(uint256).max, "a");
        vm.expectRevert(IPyusd.InvalidSignature.selector);
        vault.depositWithAuthorization(agentId - 1, from, AMOUNT, 0, type(uint256).max, "a", sig);
        assertEq(vault.bonds(agentId - 1).free, 0);
    }

    /// @dev The registry reverts `ownerOf` for an id it has not minted.
    function test_depositWithAuthorization_unmintedAgentReverts() public {
        uint256 unminted = agentId + 1_000_000;
        (address from, uint256 pk) = _funder(0);
        bytes memory sig = _signReceiveWithAuthorization(
            pk, address(vault), AMOUNT, 0, type(uint256).max, keccak256(abi.encode(unminted, bytes32("a")))
        );
        vm.expectRevert();
        vault.depositWithAuthorization(unminted, from, AMOUNT, 0, type(uint256).max, "a", sig);
    }

    function test_depositWithAuthorization_replayReverts() public {
        (address from, bytes memory sig) = _authorization(0, type(uint256).max, "a");
        vault.depositWithAuthorization(agentId, from, AMOUNT, 0, type(uint256).max, "a", sig);
        vm.expectRevert(IKeelsonBondVault.AuthorizationNotUsed.selector);
        vault.depositWithAuthorization(agentId, from, AMOUNT, 0, type(uint256).max, "a", sig);
        assertEq(_bond().free, AMOUNT);
    }

    function test_depositWithAuthorization_beforeValidAfterReverts() public {
        uint256 validAfter = vm.getBlockTimestamp() + 1 hours;
        (address from, bytes memory sig) = _authorization(validAfter, type(uint256).max, "a");
        vm.expectRevert(IPyusd.AuthorizationInvalid.selector);
        vault.depositWithAuthorization(agentId, from, AMOUNT, validAfter, type(uint256).max, "a", sig);
    }

    /// @dev The operator holds no faucet PYUSD; a funder sends it some on the fork with a plain transfer.
    function _fundOperator() internal {
        (address from,) = _funder(1);
        vm.prank(from);
        assertTrue(pyusd.transfer(operator, AMOUNT));
    }

    function test_depositWithPermit() public {
        _fundOperator();
        bytes memory sig = _signPermit(operatorKey, address(vault), AMOUNT, type(uint256).max);
        vm.prank(makeAddr("relayer"));
        vault.depositWithPermit(agentId, operator, AMOUNT, type(uint256).max, sig);
        emit log_named_uint(
            "depositWithPermit execution",
            _executionGas(abi.encodeCall(vault.depositWithPermit, (agentId, operator, AMOUNT, type(uint256).max, sig)))
        );
        assertEq(_bond().free, AMOUNT);
        assertEq(pyusd.balanceOf(operator), 0);
    }

    function test_depositWithPermit_frontRunPermitStillWorks() public {
        _fundOperator();
        bytes memory sig = _signPermit(operatorKey, address(vault), AMOUNT, type(uint256).max);
        pyusd.permit(operator, address(vault), AMOUNT, type(uint256).max, sig);
        vault.depositWithPermit(agentId, operator, AMOUNT, type(uint256).max, sig);
        assertEq(_bond().free, AMOUNT);
    }

    function test_depositWithPermit_revertsForNonAuthority() public {
        (address funder, uint256 pk) = _funder(1);
        bytes memory sig = _signPermit(pk, address(vault), AMOUNT, type(uint256).max);
        vm.expectRevert(IKeelsonBondVault.NotAgentAuthority.selector);
        vault.depositWithPermit(agentId, funder, AMOUNT, type(uint256).max, sig);
    }

    function _demoParams() internal view returns (IKeelsonBondVault.Params memory) {
        return deployScript.params();
    }

    function test_setParams_revertsWhenWithdrawalDelayTooShort() public {
        IKeelsonBondVault.Params memory p = _demoParams();
        p.withdrawalDelay = p.disputeWindow + p.vetoWindow + p.grace - 1;
        vm.expectRevert(IKeelsonBondVault.InvalidParams.selector);
        this.viaTimelock(address(vault), abi.encodeCall(vault.setParams, (p)));
    }

    function test_setParams_onlyAdmin() public {
        IKeelsonBondVault.Params memory p = _demoParams();
        p.disputeWindow += 60;
        p.withdrawalDelay += 60;
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, address(this)));
        vault.setParams(p);
        _viaTimelock(address(vault), abi.encodeCall(vault.setParams, (p)));
        assertEq(vault.params().disputeWindow, p.disputeWindow);
    }

    function viaTimelock(address to, bytes calldata data) external {
        _viaTimelock(to, data);
    }
}
