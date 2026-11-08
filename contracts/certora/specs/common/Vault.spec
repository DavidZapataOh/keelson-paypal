// The scene shared by the vault's specs: KeelsonBondVault linked to the real VerdictVerifier, CheckpointAnchor and
// KeelsonReserve, with OpenZeppelin's ERC20 as the token. No loop is unrolled optimistically: the only loops the vault
// reaches (the passkey's WebAuthn parsing and the batch Merkle proof) are summarized below.

import "Erc20.spec";

using KeelsonReserve as reserve;
using VerdictVerifier as verifier;
using CheckpointAnchor as anchorContract;

methods {
    function settled(bytes32) external returns (bool) envfree;
    function slashed(bytes32) external returns (uint96) envfree;
    function claimable(address) external returns (uint256) envfree;
    function pendingSlashes(uint256) external returns (uint256) envfree;
    function payoutAddress(address) external returns (address) envfree;
    function logOrigin() external returns (bytes32) envfree;
    function authority() external returns (address) envfree;
    function coverages(bytes32) external returns (IKeelsonBondVault.CoverageState) envfree;
    function withdrawals(uint256) external returns (IKeelsonBondVault.Withdrawal) envfree;
    function queuedSlashes(bytes32) external returns (IKeelsonBondVault.QueuedSlash) envfree;
    function params() external returns (IKeelsonBondVault.Params) envfree;
    function verdictStructHash(KeelsonTypes.Verdict) external returns (bytes32) envfree;
    function countersignStructHash(KeelsonTypes.Countersign) external returns (bytes32) envfree;
    function reentrancyGuardEntered() external returns (bool) envfree;

    function reserve.settled(bytes32) external returns (bool) envfree;
    function reserve.warranted(bytes32) external returns (uint256) envfree;
    function anchorContract.rootAt(bytes32, uint64) external returns (bytes32) envfree;

    // The user's passkey assertion (P-256 through the RIP-7212 precompile, Base64url and JSON offsets): no vault
    // property depends on WebAuthn parsing; any result is allowed, so every rule holds for a forged assertion too.
    function PasskeyAssertion.verify(bytes32, PasskeyAssertion.Assertion calldata, bytes32, bytes32, bytes32) internal returns (bool) => NONDET;
    // The batch leaf's Merkle proof (a loop over the proof): any result is allowed, the weakest assumption.
    function MerkleProof.verifyCalldata(bytes32[] calldata, bytes32, bytes32) internal returns (bool) => NONDET;
    // The ERC-8004 Identity registry is not in the scene: any owner and agent wallet, including the vault itself.
    function _.ownerOf(uint256) external => NONDET;
    function _.getAgentWallet(uint256) external => NONDET;
    // ERC-1271 signers: any answer.
    function _.isValidSignature(bytes32, bytes) external => NONDET;
    // The AccessManager is not in the scene for the vault: any authorization decision, no effect on the vault.
    function _.canCall(address, address, bytes4) external => NONDET;
    function _.consumeScheduledOp(address, bytes) external => NONDET;
    // EIP-3009 (PYUSD has it, OpenZeppelin's ERC20 does not): `from` pays `to` exactly `value`.
    function _.receiveWithAuthorization(address from, address to, uint256 value, uint256, uint256, bytes32, bytes) external with (env e) => receiveWithAuthorizationCVL(e, from, to, value) expect void ALL;
}

// EIP-3009 `receiveWithAuthorization` as the token transfer it authorizes. A refused authorization reverts the whole
// deposit, so dropping that path loses no reachable post-state.
function receiveWithAuthorizationCVL(env e, address from, address to, uint256 value) {
    require to == e.msg.sender, "EIP-3009 receiveWithAuthorization requires the payee to be the caller";
    requireNoBalanceOverflow(from, to);
    env t;
    require t.msg.sender == from && t.msg.value == 0, "the authorization moves the signer's own tokens";
    token.transfer(t, to, value);
}

definition DEGRADED_SECONDS() returns mathint = 72 * 3600;

definition isSlash(method f) returns bool =
    f.selector == sig:slash(KeelsonTypes.Verdict, uint64, bytes).selector
    || f.selector == sig:slashBatched(KeelsonTypes.Verdict, uint64, bytes, bytes32, KeelsonTypes.Coverage, bytes32[]).selector;

definition isSettlement(method f) returns bool =
    isSlash(f) || f.selector == sig:executeSlash(bytes32).selector;

function callSlash(env e, method f, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs) {
    if (f.selector == sig:slash(KeelsonTypes.Verdict, uint64, bytes).selector) {
        slash(e, v, treeSize, sigs);
    } else {
        bytes32 batchId;
        KeelsonTypes.Coverage c;
        bytes32[] proof;
        slashBatched(e, v, treeSize, sigs, batchId, c, proof);
    }
}

function callSlashMayRevert(env e, method f, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs) returns bool {
    if (f.selector == sig:slash(KeelsonTypes.Verdict, uint64, bytes).selector) {
        slash@withrevert(e, v, treeSize, sigs);
    } else {
        bytes32 batchId;
        KeelsonTypes.Coverage c;
        bytes32[] proof;
        slashBatched@withrevert(e, v, treeSize, sigs, batchId, c, proof);
    }
    return lastReverted;
}

function recipientOf(address payee) returns address {
    address payout = payoutAddress(payee);
    return payout == 0 ? payee : payout;
}

// ---------------------------------------------------------------- ghosts

ghost mathint sumFree {
    init_state axiom sumFree == 0;
}
ghost mathint sumLocked {
    init_state axiom sumLocked == 0;
}
ghost mathint sumQueued {
    init_state axiom sumQueued == 0;
}
ghost mathint sumClaimable {
    init_state axiom sumClaimable == 0;
}

hook Sstore _bonds[KEY uint256 a].free uint128 v (uint128 oldValue) {
    sumFree = sumFree + v - oldValue;
}
hook Sstore _bonds[KEY uint256 a].locked uint128 v (uint128 oldValue) {
    sumLocked = sumLocked + v - oldValue;
}
hook Sstore _bonds[KEY uint256 a].queued uint128 v (uint128 oldValue) {
    sumQueued = sumQueued + v - oldValue;
}
hook Sstore claimable[KEY address a] uint256 v (uint256 oldValue) {
    sumClaimable = sumClaimable + v - oldValue;
}

ghost bool unguardedCall;
ghost bool strayCall;
ghost address authorityAddress;

hook CALL(uint g, address addr, uint value, uint argsOffset, uint argsLength, uint retOffset, uint retLength) uint rc {
    if (executingContract == currentContract) {
        if (addr != authorityAddress && !reentrancyGuardEntered()) {
            unguardedCall = true;
        }
        if (addr != token && addr != authorityAddress) {
            strayCall = true;
        }
    }
}

// ---------------------------------------------------------------- I4

/// Every bond and every claimable payout is backed by the vault's token balance.
invariant conservation()
    sumFree + sumLocked + sumQueued + sumClaimable <= to_mathint(token.balanceOf(currentContract))
    {
        preserved depositWithPermit(uint256 agentId, address owner, uint256 amount, uint256 deadline, bytes signature) with (env e) {
            requireNoBalanceOverflow(owner, currentContract);
            // The vault never approves, never signs a permit and implements no ERC-1271, so no allowance it granted
            // can exist on the token.
            require token.allowance(currentContract, currentContract) == 0, "the vault grants no allowance";
        }
    }

rule conservationReachable(env e, method f, calldataarg args) filtered { f -> !f.isView } {
    f(e, args);
    satisfy sumFree + sumLocked + sumQueued + sumClaimable > 0;
}
