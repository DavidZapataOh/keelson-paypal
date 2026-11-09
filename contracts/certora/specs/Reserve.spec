// KeelsonReserve, linked to the real VerdictVerifier, CheckpointAnchor and KeelsonBondVault, with OpenZeppelin's ERC20
// as its asset. No loop is reached.

import "common/Erc20.spec";

using VerdictVerifier as verifier;
using KeelsonBondVault as vault;

methods {
    function settled(bytes32) external returns (bool) envfree;
    function verdictStructHash(KeelsonTypes.Verdict) external returns (bytes32) envfree;
    function vault.settled(bytes32) external returns (bool) envfree;
    function vault.coverages(bytes32) external returns (IKeelsonBondVault.CoverageState) envfree;

    // The AccessManager is not in the scene: any authorization decision, no effect on the reserve.
    function _.canCall(address, address, bytes4) external => NONDET;
    function _.consumeScheduledOp(address, bytes) external => NONDET;
}

// ---------------------------------------------------------------- RSV1

/// A warranty pays only on both TEE signatures and settles its dispute, which neither the reserve nor the vault had
/// settled; so it pays at most once per dispute.
rule warrantySingleUse(env e, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs) {
    bool alreadySettled = settled(v.disputeId) || vault.settled(v.disputeId);
    bytes32 digest = verifier.hashTypedData(e, verdictStructHash(v));
    bool twoOfTwo = sigs.length == 130 && verifier.verify2of2(e, digest, sigs);
    payWarranty(e, v, treeSize, sigs);
    assert !alreadySettled && twoOfTwo && settled(v.disputeId);
}

rule warrantySingleUseReachable(env e, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs) {
    payWarranty(e, v, treeSize, sigs);
    satisfy settled(v.disputeId);
}

// ---------------------------------------------------------------- LIA

rule warrantyOnlyKeelsonLiable(env e, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs) {
    payWarranty(e, v, treeSize, sigs);
    assert v.liable == 2;
}

rule warrantyOnlyKeelsonLiableReachable(env e, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs) {
    payWarranty(e, v, treeSize, sigs);
    satisfy v.liable == 2;
}

/// A warranty is paid only against a coverage the vault holds for the verdict's agent.
rule warrantyOnlyForHeldCoverage(env e, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs) {
    IKeelsonBondVault.CoverageState cov = vault.coverages(v.coverageId);
    payWarranty(e, v, treeSize, sigs);
    assert cov.status != IKeelsonBondVault.Status.None && to_mathint(cov.agentId) == to_mathint(v.agentId);
}

rule warrantyOnlyForHeldCoverageReachable(env e, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs) {
    payWarranty(e, v, treeSize, sigs);
    satisfy true;
}

// ---------------------------------------------------------------- RSV2

/// Assets leave the pool for a staker only inside that staker's window, from `cooldown` to `cooldown + unstakeWindow`
/// after it requested the cooldown.
rule reserveCooldown(env e, method f, address receiver, address owner)
    filtered {
        f -> f.selector == sig:withdraw(uint256, address, address).selector
            || f.selector == sig:redeem(uint256, address, address).selector
    }
{
    bool open = inWindow(e, owner);
    uint256 assetsBefore = token.balanceOf(currentContract);
    if (f.selector == sig:withdraw(uint256, address, address).selector) {
        uint256 assets;
        withdraw(e, assets, receiver, owner);
    } else {
        uint256 shares;
        redeem(e, shares, receiver, owner);
    }
    assert token.balanceOf(currentContract) < assetsBefore => open;
}

rule reserveCooldownReachable(env e, uint256 shares, address receiver, address owner) {
    require receiver != currentContract;
    uint256 assetsBefore = token.balanceOf(currentContract);
    redeem(e, shares, receiver, owner);
    satisfy token.balanceOf(currentContract) < assetsBefore;
}
