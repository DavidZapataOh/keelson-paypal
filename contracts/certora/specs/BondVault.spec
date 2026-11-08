import "common/Vault.spec";

use invariant conservation;
use rule conservationReachable;

// ---------------------------------------------------------------- I1

/// A slash succeeds only with both legs' signatures by active signers, or a lone active TDX signature, over the
/// verdict's digest; before its deadline; naming a checkpoint anchored for the vault's log.
rule slashRequiresValidVerdict(env e, method f, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs)
    filtered { f -> isSlash(f) }
{
    bytes32 digest = verifier.hashTypedData(e, verdictStructHash(v));
    bool twoOfTwo = sigs.length == 130 && verifier.verify2of2(e, digest, sigs);
    bool degraded = sigs.length == 65 && verifier.verifyDegraded(e, digest, sigs);
    bytes32 anchored = anchorContract.rootAt(logOrigin(), treeSize);

    callSlash(e, f, v, treeSize, sigs);

    assert twoOfTwo || degraded;
    assert e.block.timestamp <= v.deadline;
    assert v.checkpointRoot != to_bytes32(0) && anchored == v.checkpointRoot;
}

rule slashRequiresValidVerdictReachable(env e, method f, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs)
    filtered { f -> isSlash(f) }
{
    callSlash(e, f, v, treeSize, sigs);
    satisfy true;
}

// ---------------------------------------------------------------- I2

rule settledIsPermanent(env e, method f, calldataarg args, bytes32 disputeId) {
    bool before = settled(disputeId);
    f(e, args);
    assert before => settled(disputeId);
}

rule settledIsPermanentReachable(env e, method f, calldataarg args, bytes32 disputeId) filtered { f -> isSlash(f) } {
    require !settled(disputeId);
    f(e, args);
    satisfy settled(disputeId);
}

/// A dispute settled by the vault or by the reserve never settles again.
rule noDoubleSettle(env e, method f, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs) filtered { f -> isSlash(f) } {
    require settled(v.disputeId) || reserve.settled(v.disputeId);
    bool reverted = callSlashMayRevert(e, f, v, treeSize, sigs);
    assert reverted;
}

rule noDoubleSettleReachable(env e, method f, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs)
    filtered { f -> isSlash(f) }
{
    require !settled(v.disputeId) && !reserve.settled(v.disputeId);
    callSlash(e, f, v, treeSize, sigs);
    satisfy settled(v.disputeId);
}

/// A queued slash always belongs to a settled dispute.
invariant queuedImpliesSettled(bytes32 disputeId)
    queuedSlashes(disputeId).status != IKeelsonBondVault.SlashStatus.None => settled(disputeId);

// ---------------------------------------------------------------- I3

/// What slashes and warranties take from a coverage never exceeds it.
invariant slashedWithinCoverage(bytes32 coverageId)
    coverages(coverageId).status != IKeelsonBondVault.Status.None
        => slashed(coverageId) + reserve.warranted(coverageId) <= to_mathint(coverages(coverageId).amount)
    {
        preserved lockCoverage(KeelsonTypes.Coverage c, KeelsonTypes.Countersign cs, bytes32 hSd, PasskeyAssertion.Assertion userAuth, bytes32 qx, bytes32 qy, bytes operatorSig, bytes countersigs) with (env e) {
            // The reserve pays a warranty only for a coverage the vault holds (`warrantyOnlyForHeldCoverage`).
            require reserve.warranted(c.coverageId) == 0, "no warranty before the coverage exists";
            // A coverage id is never also a slashed batch leaf: ids are the TEE-assigned request ids, unique per
            // purchase. The vault does not enforce it (see the finding on batch leaf reuse).
            require slashed(c.coverageId) == 0, "a new coverage id was never slashed as a batch leaf";
        }
    }

rule slashedWithinCoverageReachable(env e, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs) {
    slash(e, v, treeSize, sigs);
    satisfy slashed(v.coverageId) > 0;
}

// ---------------------------------------------------------------- I5

rule noEarlyWithdrawal(env e, uint256 id) {
    IKeelsonBondVault.Withdrawal w = withdrawals(id);
    uint256 pending = pendingSlashes(w.agentId);
    completeWithdrawal(e, id);
    assert e.block.timestamp >= w.readyAt && pending == 0;
}

rule noEarlyWithdrawalReachable(env e, uint256 id) {
    address to = withdrawals(id).to;
    require to != currentContract;
    uint256 before = token.balanceOf(to);
    completeWithdrawal(e, id);
    satisfy token.balanceOf(to) > before;
}

// ---------------------------------------------------------------- I6

/// A withdrawal stores exactly the signed recipient and amount, and completing it pays only that recipient, at most
/// that amount.
rule withdrawalPaysSignedTo(env e, method f, address other)
    filtered {
        f -> f.selector == sig:requestWithdrawal(uint256, uint128, address, uint256, uint256, bytes).selector
            || f.selector == sig:completeWithdrawal(uint256).selector
    }
{
    if (f.selector == sig:requestWithdrawal(uint256, uint128, address, uint256, uint256, bytes).selector) {
        uint256 agentId;
        uint128 amount;
        address to;
        uint256 nonce;
        uint256 deadline;
        bytes ownerSig;
        uint256 id = requestWithdrawal(e, agentId, amount, to, nonce, deadline, ownerSig);
        IKeelsonBondVault.Withdrawal w = withdrawals(id);
        assert w.to == to && w.amount == amount && to_mathint(w.agentId) == to_mathint(agentId);
    } else {
        uint256 id;
        IKeelsonBondVault.Withdrawal w = withdrawals(id);
        require other != w.to && other != currentContract;
        requireNoBalanceOverflow(w.to, currentContract);
        uint256 otherBefore = token.balanceOf(other);
        uint256 toBefore = token.balanceOf(w.to);
        completeWithdrawal(e, id);
        assert token.balanceOf(other) == otherBefore;
        assert w.to != currentContract => token.balanceOf(w.to) - toBefore <= to_mathint(w.amount);
    }
}

rule withdrawalPaysSignedToReachable(env e, uint256 agentId, uint128 amount, address to, uint256 nonce, uint256 deadline, bytes ownerSig) {
    uint256 id = requestWithdrawal(e, agentId, amount, to, nonce, deadline, ownerSig);
    satisfy withdrawals(id).amount > 0;
}

// ---------------------------------------------------------------- I7

/// A slash either queues the verdict as signed, or pays the payee's payout address (or the payee) exactly the amount,
/// by transfer or as a claimable credit; nobody else's balance moves.
rule slashPaysPayeeExactly(env e, method f, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs, bytes32 disputeId, address other)
    filtered { f -> isSettlement(f) }
{
    address payee;
    mathint amount;
    if (f.selector == sig:executeSlash(bytes32).selector) {
        IKeelsonBondVault.QueuedSlash q = queuedSlashes(disputeId);
        payee = q.payee;
        amount = q.amount;
    } else {
        payee = v.payee;
        amount = v.amount;
        requireInvariant queuedImpliesSettled(v.disputeId);
    }
    address recipient = recipientOf(payee);
    // A payout address set to the vault itself would only burn the merchant's own payout.
    require recipient != currentContract, "the payout recipient is not the vault";
    require other != recipient && other != currentContract;
    requireNoBalanceOverflow(recipient, currentContract);
    uint256 balanceBefore = token.balanceOf(recipient);
    uint256 claimableBefore = claimable(recipient);
    uint256 otherBefore = token.balanceOf(other);

    if (f.selector == sig:executeSlash(bytes32).selector) {
        executeSlash(e, disputeId);
    } else {
        callSlash(e, f, v, treeSize, sigs);
    }

    mathint paid = token.balanceOf(recipient) - balanceBefore;
    mathint credited = claimable(recipient) - claimableBefore;
    IKeelsonBondVault.QueuedSlash q = queuedSlashes(v.disputeId);
    bool queued = f.selector != sig:executeSlash(bytes32).selector
        && q.status == IKeelsonBondVault.SlashStatus.Queued && q.payee == v.payee && to_mathint(q.amount) == amount;
    assert token.balanceOf(other) == otherBefore;
    assert (queued && paid == 0 && credited == 0)
        || (paid == amount && credited == 0)
        || (paid == 0 && credited == amount);
}

rule slashPaysPayeeExactlyReachable(env e, bytes32 disputeId) {
    address recipient = recipientOf(queuedSlashes(disputeId).payee);
    uint256 claimableBefore = claimable(recipient);
    executeSlash(e, disputeId);
    satisfy claimable(recipient) > claimableBefore;
}

// ---------------------------------------------------------------- I9

/// The only accounts whose token balance a vault call raises are a completed withdrawal's recipient, a verdict's
/// recipient, a claimant's chosen `to` and the reserve (premiums). Pause changes none of this.
rule outflowsOnlyToEntitled(env e, method f, calldataarg args, address x) filtered { f -> !f.isView } {
    require x != currentContract;
    uint256 before = token.balanceOf(x);
    address entitled = 0;
    bool any = false;
    if (f.selector == sig:completeWithdrawal(uint256).selector) {
        uint256 id;
        entitled = withdrawals(id).to;
        completeWithdrawal(e, id);
    } else if (f.selector == sig:claim(address, address, uint256, uint256, bytes).selector) {
        address account;
        address to;
        uint256 nonce;
        uint256 deadline;
        bytes claimSig;
        entitled = to;
        claim(e, account, to, nonce, deadline, claimSig);
    } else if (isSlash(f)) {
        KeelsonTypes.Verdict v;
        uint64 treeSize;
        bytes sigs;
        entitled = recipientOf(v.payee);
        callSlash(e, f, v, treeSize, sigs);
    } else if (f.selector == sig:executeSlash(bytes32).selector) {
        bytes32 disputeId;
        entitled = recipientOf(queuedSlashes(disputeId).payee);
        executeSlash(e, disputeId);
    } else if (
        f.selector == sig:lockCoverage(KeelsonTypes.Coverage, KeelsonTypes.Countersign, bytes32, PasskeyAssertion.Assertion, bytes32, bytes32, bytes, bytes).selector
        || f.selector == sig:lockCoverageBatch(KeelsonTypes.CoverageBatch, bytes).selector
    ) {
        entitled = reserve;
        f(e, args);
    } else {
        f(e, args);
    }
    assert token.balanceOf(x) > before => x == entitled && entitled != 0;
}

rule outflowsOnlyToEntitledReachable(env e, address account, address to, uint256 nonce, uint256 deadline, bytes claimSig) {
    require to != currentContract;
    uint256 before = token.balanceOf(to);
    claim(e, account, to, nonce, deadline, claimSig);
    satisfy token.balanceOf(to) > before;
}

// ---------------------------------------------------------------- I10

/// Every state-changing external call the vault makes (to the token, including the inline-assembly calls in
/// SafeERC20) happens inside the reentrancy guard. The AccessManager's `consumeScheduledOp`, reached from the
/// `restricted` modifier before any state change, is the one exception.
rule externalCallsHoldLock(env e, method f, calldataarg args) {
    require !unguardedCall;
    require authorityAddress == authority();
    f(e, args);
    assert !unguardedCall;
}

rule externalCallsHoldLockReachable(env e, uint256 id) {
    require authorityAddress == authority();
    require !unguardedCall;
    completeWithdrawal(e, id);
    satisfy withdrawals(id).amount == 0;
}

// ---------------------------------------------------------------- LIA

rule slashOnlyOperatorLiable(env e, method f, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs)
    filtered { f -> isSlash(f) }
{
    callSlash(e, f, v, treeSize, sigs);
    assert v.liable == 1;
}

rule slashOnlyOperatorLiableReachable(env e, method f, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs)
    filtered { f -> isSlash(f) }
{
    callSlash(e, f, v, treeSize, sigs);
    satisfy v.liable == 1;
}

// ---------------------------------------------------------------- DEG1

/// A lone signature locks coverage or slashes only when it is an active TDX signer's (`verifyDegraded`); a lone Nitro
/// signature never does.
rule degradedOnlyTdx(env e, method f, calldataarg args)
    filtered {
        f -> isSlash(f)
            || f.selector == sig:lockCoverage(KeelsonTypes.Coverage, KeelsonTypes.Countersign, bytes32, PasskeyAssertion.Assertion, bytes32, bytes32, bytes, bytes).selector
    }
{
    bytes sigs;
    bytes32 digest;
    if (isSlash(f)) {
        KeelsonTypes.Verdict v;
        uint64 treeSize;
        digest = verifier.hashTypedData(e, verdictStructHash(v));
        callSlash(e, f, v, treeSize, sigs);
    } else {
        KeelsonTypes.Coverage c;
        KeelsonTypes.Countersign cs;
        bytes32 hSd;
        PasskeyAssertion.Assertion userAuth;
        bytes32 qx;
        bytes32 qy;
        bytes operatorSig;
        digest = verifier.hashTypedData(e, countersignStructHash(cs));
        lockCoverage(e, c, cs, hSd, userAuth, qx, qy, operatorSig, sigs);
    }
    assert sigs.length == 65 => verifier.verifyDegraded(e, digest, sigs);
}

rule degradedOnlyTdxReachable(env e, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs) {
    require sigs.length == 65;
    slash(e, v, treeSize, sigs);
    satisfy true;
}

// ---------------------------------------------------------------- DEG2

/// A degraded verdict, or any slash of a coverage locked degraded, never pays at once: it is queued for at least 72 h,
/// and a queued slash executes only once its time has come.
rule degradedNeverInstant(env e, method f, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs, bytes32 disputeId)
    filtered { f -> isSettlement(f) }
{
    if (f.selector == sig:executeSlash(bytes32).selector) {
        IKeelsonBondVault.QueuedSlash q = queuedSlashes(disputeId);
        executeSlash(e, disputeId);
        assert e.block.timestamp >= q.readyAt;
    } else {
        bool coverageDegraded = f.selector == sig:slash(KeelsonTypes.Verdict, uint64, bytes).selector
            && coverages(v.coverageId).degraded;
        address recipient = recipientOf(v.payee);
        uint256 vaultBalance = token.balanceOf(currentContract);
        uint256 claimableBefore = claimable(recipient);
        callSlash(e, f, v, treeSize, sigs);
        IKeelsonBondVault.QueuedSlash q = queuedSlashes(v.disputeId);
        assert (sigs.length == 65 || coverageDegraded) => (
            token.balanceOf(currentContract) == vaultBalance && claimable(recipient) == claimableBefore
                && q.status == IKeelsonBondVault.SlashStatus.Queued
                && to_mathint(q.readyAt) >= e.block.timestamp + DEGRADED_SECONDS()
        );
    }
}

rule degradedNeverInstantReachable(env e, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs) {
    require coverages(v.coverageId).degraded;
    slash(e, v, treeSize, sigs);
    satisfy queuedSlashes(v.disputeId).status == IKeelsonBondVault.SlashStatus.Queued;
}

// ---------------------------------------------------------------- VAL3 (vault side)

/// The vault makes state-changing calls only to the token and its AccessManager: no reputation or validation registry
/// is ever called, so none can block a release or a slash.
rule vaultCallsNoRegistry(env e, method f, calldataarg args) {
    require !strayCall;
    require authorityAddress == authority();
    f(e, args);
    assert !strayCall;
}

rule vaultCallsNoRegistryReachable(env e, bytes32 coverageId) {
    require !strayCall;
    require authorityAddress == authority();
    releaseCoverage(e, coverageId);
    satisfy !strayCall;
}
