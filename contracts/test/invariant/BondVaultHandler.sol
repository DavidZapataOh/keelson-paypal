// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../../script/CoverageVector.sol";
import {KeelsonBondVault} from "../../src/KeelsonBondVault.sol";
import {IKeelsonBondVault} from "../../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {IPyusd} from "../utils/IPyusd.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

/// @notice Drives the vault with real signatures: EIP-3009 deposits by the funders' keys, the live coverages (each at
/// most once: their countersigns cannot repeat), releases, withdrawal requests signed by the operator, completions and
/// time. Ghost totals record every PYUSD movement across the vault's boundary.
contract BondVaultHandler is CommonBase, StdUtils {
    /// @dev keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;

    KeelsonBondVault internal immutable vault;
    IPyusd internal immutable pyusd;
    uint256 internal immutable agentId;
    uint256 internal immutable operatorKey;
    address internal immutable recipient;

    uint256[] internal funderKeys;
    Vector[] internal vectors;
    bool[] internal locked;
    uint256 internal salts;

    uint256[] public agents;
    uint256[] public pendingWithdrawals;
    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public premiums;

    constructor(
        KeelsonBondVault vault_,
        IPyusd pyusd_,
        uint256 agentId_,
        uint256 operatorKey_,
        uint256[] memory funderKeys_,
        Vector[] memory vectors_
    ) {
        vault = vault_;
        pyusd = pyusd_;
        agentId = agentId_;
        operatorKey = operatorKey_;
        recipient = vm.addr(uint256(keccak256("operator treasury")));
        funderKeys = funderKeys_;
        for (uint256 i; i < vectors_.length; ++i) {
            vectors.push(vectors_[i]);
            locked.push(false);
        }
        agents.push(agentId_);
        agents.push(agentId_ - 1);
    }

    function agentCount() external view returns (uint256) {
        return agents.length;
    }

    function deposit(uint256 funderSeed, uint256 amountSeed, uint256 agentSeed) public virtual {
        uint256 pk = funderKeys[funderSeed % funderKeys.length];
        address from = vm.addr(pk);
        uint256 balance = pyusd.balanceOf(from);
        if (balance == 0) return;
        uint256 amount = bound(amountSeed, 1, balance);
        uint256 agent = agents[agentSeed % agents.length];
        bytes32 salt = bytes32(++salts);
        bytes32 nonce = keccak256(abi.encode(agent, salt));
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, address(vault), amount, 0, type(uint256).max, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", pyusd.DOMAIN_SEPARATOR(), structHash)));
        vault.depositWithAuthorization(agent, from, amount, 0, type(uint256).max, salt, abi.encodePacked(r, s, v));
        deposited += amount;
    }

    function lock(uint256 which) public virtual {
        uint256 i = which % vectors.length;
        Vector memory v = vectors[i];
        if (locked[i] || block.timestamp >= v.coverage.expiresAt) return;
        if (vault.bonds(agentId).free < uint256(v.coverage.amount) + v.coverage.premium) return;
        if (block.timestamp < v.countersign.issuedAt) vm.warp(v.countersign.issuedAt);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(
            operatorKey, keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), KeelsonTypes.hash(v.coverage)))
        );
        vault.lockCoverage(
            v.coverage, v.countersign, v.hSd, v.assertion, v.qx, v.qy, abi.encodePacked(r, s, sv), v.countersigs
        );
        locked[i] = true;
        premiums += v.coverage.premium;
    }

    function release(uint256 which) public virtual {
        uint256 i = which % vectors.length;
        bytes32 id = vectors[i].coverage.coverageId;
        IKeelsonBondVault.CoverageState memory c = vault.coverages(id);
        if (c.status != IKeelsonBondVault.Status.Active || block.timestamp <= c.releaseAfter) return;
        vault.releaseCoverage(id);
    }

    function request(uint256 amountSeed) public virtual {
        uint128 free = vault.bonds(agentId).free;
        if (free == 0) return;
        uint128 amount = uint128(bound(amountSeed, 1, free));
        address operator = vm.addr(operatorKey);
        uint256 nonce = vault.nonces(operator);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            operatorKey,
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    vault.domainSeparator(),
                    KeelsonTypes.hashWithdrawal(agentId, amount, recipient, nonce, deadline)
                )
            )
        );
        pendingWithdrawals.push(
            vault.requestWithdrawal(agentId, amount, recipient, nonce, deadline, abi.encodePacked(r, s, v))
        );
    }

    function complete(uint256 which) public virtual {
        if (pendingWithdrawals.length == 0) return;
        uint256 i = which % pendingWithdrawals.length;
        uint256 id = pendingWithdrawals[i];
        if (block.timestamp < vault.withdrawals(id).readyAt) return;
        uint256 before = pyusd.balanceOf(recipient);
        vault.completeWithdrawal(id);
        withdrawn += pyusd.balanceOf(recipient) - before;
        pendingWithdrawals[i] = pendingWithdrawals[pendingWithdrawals.length - 1];
        pendingWithdrawals.pop();
    }

    function warp(uint256 secondsSeed) public virtual {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 6 hours));
    }
}
