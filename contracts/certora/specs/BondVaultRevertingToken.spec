// The vault with a token whose every transfer may fail, which is how a Paxos freeze of the payee or of the vault, or a
// pause of PYUSD, looks to it. SafeERC20 treats a revert and a `false` return alike, so a revert models both.

import "common/Vault.spec";

use invariant conservation;
use rule conservationReachable;

methods {
    function token.transfer(address to, uint256 value) external returns (bool) with (env e) => transferMayFail(e, to, value);
    function token.transferFrom(address from, address to, uint256 value) external returns (bool) with (env e) => transferFromMayFail(e, from, to, value);
}

// A frozen sender or recipient, or a paused token, reverts; otherwise the real ERC20 transfer runs.
function transferMayFail(env e, address to, uint256 value) returns bool {
    bool fails;
    if (fails) {
        revert("frozen or paused");
    }
    env t;
    require t.msg.sender == e.msg.sender && t.msg.value == 0, "the token sees its caller";
    requireNoBalanceOverflow(e.msg.sender, to);
    return token.transfer(t, to, value);
}

function transferFromMayFail(env e, address from, address to, uint256 value) returns bool {
    bool fails;
    if (fails) {
        revert("frozen or paused");
    }
    env t;
    require t.msg.sender == e.msg.sender && t.msg.value == 0, "the token sees its caller";
    requireNoBalanceOverflow(from, to);
    return token.transferFrom(t, from, to, value);
}

/// A settlement whose transfer fails credits the recipient exactly the amount as claimable instead of reverting, and the
/// vault keeps the funds.
rule failedPayoutIsClaimable(env e, method f, KeelsonTypes.Verdict v, uint64 treeSize, bytes sigs, bytes32 disputeId)
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
    }
    address recipient = recipientOf(payee);
    require recipient != currentContract, "the payout recipient is not the vault";
    uint256 recipientBefore = token.balanceOf(recipient);
    uint256 vaultBefore = token.balanceOf(currentContract);
    uint256 claimableBefore = claimable(recipient);

    if (f.selector == sig:executeSlash(bytes32).selector) {
        executeSlash(e, disputeId);
    } else {
        callSlash(e, f, v, treeSize, sigs);
    }

    mathint paid = token.balanceOf(recipient) - recipientBefore;
    mathint credited = claimable(recipient) - claimableBefore;
    assert paid == 0 && credited != 0 => credited == amount && token.balanceOf(currentContract) == vaultBefore;
    assert credited == 0 || paid == 0;
}

rule failedPayoutIsClaimableReachable(env e, bytes32 disputeId) {
    address recipient = recipientOf(queuedSlashes(disputeId).payee);
    uint256 claimableBefore = claimable(recipient);
    uint256 recipientBefore = token.balanceOf(recipient);
    executeSlash(e, disputeId);
    satisfy claimable(recipient) > claimableBefore && token.balanceOf(recipient) == recipientBefore;
}
