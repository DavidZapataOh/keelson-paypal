// KeelsonReputationReporter, linked to the real KeelsonBondVault, with the ERC-8004 Reputation registry's
// `giveFeedback` always reverting. The feedback URI (a hex encoding loop) is summarized as any string.

using KeelsonBondVault as vault;

methods {
    function rated(bytes32) external returns (bool) envfree;
    function unratedSlashes(uint256) external returns (uint256) envfree;
    function REPUTATION_GAS() external returns (uint256) envfree;
    function vault.coverages(bytes32) external returns (IKeelsonBondVault.CoverageState) envfree;
    function vault.slashed(bytes32) external returns (uint96) envfree;
    function vault.pendingSlashes(uint256) external returns (uint256) envfree;

    function feedbackURI(bytes32) internal returns (string memory) => anyString();
    // A registry that refuses every feedback (the owner approved the reporter, a paused or broken upgrade).
    function _.giveFeedback(uint256, int128, uint8, string, string, string, string, bytes32) external => refuse() expect void ALL;
}

function anyString() returns string {
    string s;
    return s;
}

function refuse() {
    revert("registry refuses");
}

persistent ghost mathint lowestGas {
    init_state axiom lowestGas == max_uint256;
}

hook GAS uint256 v {
    if (executingContract == currentContract && v < lowestGas) {
        lowestGas = v;
    }
}

/// A reverting registry never makes `rateCoverage` revert: it reverts only for its own reasons (already rated,
/// outcome not final, a slash still unrated before a clean rating, too little gas for the stipend), and otherwise
/// returns false and leaves the coverage unrated, so the rating can be retried.
rule reputationNeverBlocks(env e, bytes32 coverageId) {
    require e.msg.value == 0;
    require lowestGas == max_uint256;
    IKeelsonBondVault.CoverageState cov = vault.coverages(coverageId);
    bool wasRated = rated(coverageId);
    bool slashedAny = vault.slashed(coverageId) != 0;
    bool open = cov.status == IKeelsonBondVault.Status.None
        || (slashedAny && (cov.pendingSlashes != 0 || vault.pendingSlashes(cov.agentId) != 0))
        || (!slashedAny && cov.status != IKeelsonBondVault.Status.Released);
    bool clean = !slashedAny && cov.status == IKeelsonBondVault.Status.Released;
    bool slashUnrated = clean && unratedSlashes(cov.agentId) != 0;
    // The count of an agent's unrated slashes grows by one per coverage at most (`slashSkipped`), far below 2^256.
    require unratedSlashes(cov.agentId) < max_uint256, "unrated slashes never reach 2^256 - 1";

    bool given = rateCoverage@withrevert(e, coverageId);
    bool reverted = lastReverted;

    bool lowGas = lowestGas < REPUTATION_GAS() * 64 / 63 + 40000;
    assert reverted => wasRated || open || slashUnrated || lowGas;
    assert !reverted => !given && !rated(coverageId);
}

rule reputationNeverBlocksReachable(env e, bytes32 coverageId) {
    bool given = rateCoverage@withrevert(e, coverageId);
    satisfy !lastReverted && !given;
}
