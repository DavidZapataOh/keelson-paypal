#!/usr/bin/env bash
# Deletes one real guard from src/ (certora/seeded/<bug>.patch), runs the check that guard protects and prints its
# counterexample, then restores the source. Exits 0 when the check catches the bug, 1 when it does not.
#
#   script/seeded.sh <double-settle|any-liable|degraded-instant|anchor-rewrite|reentrancy|veto-final> <halmos|certora|forge>
set -euo pipefail
cd "$(dirname "$0")/.."

usage="usage: script/seeded.sh <double-settle|any-liable|degraded-instant|anchor-rewrite|reentrancy|veto-final> <halmos|certora|forge>"
bug=${1:?$usage}
tool=${2:?$usage}

# bug: Halmos check | Certora conf and rule | Forge test file:name (fork tests read ARBITRUM_SEPOLIA_RPC_URL)
case "$bug" in
  double-settle) check=check_noDoubleSettle conf=BondVault rule=noDoubleSettle test=test/BondVaultSlash.fork.t.sol:test_slash_revertsOnReuse ;;
  any-liable) check=check_liable conf=BondVault rule=slashOnlyOperatorLiable test=test/BondVaultSlash.fork.t.sol:test_slash_revertsUnlessOperatorLiable ;;
  degraded-instant) check=check_degradedQueued conf=BondVault rule=degradedNeverInstant test=test/BondVaultVeto.fork.t.sol:test_slash_degradedVerdictQueues72h ;;
  # Halmos 0.3.3 cannot execute the SHA-256 precompile the consistency proof hashes with.
  anchor-rewrite) check= conf=CheckpointAnchor rule=anchorChecksConsistency test=test/CheckpointAnchor.t.sol:test_rewrittenRootReverts ;;
  # A veto that leaves the dispute settled denies the payout for good.
  veto-final) check= conf=BondVault rule=vetoReopens test=test/BondVaultVeto.fork.t.sol:test_veto ;;
  # Static analyzers do not see the token call SafeERC20 makes in assembly; the Prover's CALL hook does.
  reentrancy) check= conf=BondVault rule=externalCallsHoldLock test= ;;
  *) echo "$usage" >&2; exit 2 ;;
esac

patch="certora/seeded/$bug.patch"
if ! git diff --quiet -- src; then
  echo "src/ has local changes; commit or stash them first" >&2
  exit 2
fi
git apply "$patch"
tmp=$(mktemp)
trap 'git apply -R "$patch"; rm -f "$tmp"' EXIT
echo "Applied $patch:"
git diff --stat -- src

# A removed guard can leave a variable unused, which the default profile denies.
export FOUNDRY_DENY=never
caught=0
case "$tool" in
  halmos)
    [[ -n "$check" ]] || { echo "no Halmos check for $bug" >&2; exit 2; }
    FOUNDRY_PROFILE=halmos halmos --root . --function "$check" --early-exit | tee "$tmp" || true
    grep -Eq "\[FAIL\].*$check\(" "$tmp" && grep -q "Counterexample: *$" "$tmp" && caught=1
    ;;
  certora)
    # Caught only when the named rule itself is violated, not when the run fails for another reason.
    certoraRun "certora/conf/$conf.conf" --rule "$rule" --msg "seeded $bug" --wait_for_results all || true
    script/certora-results.sh "$tmp"
    [[ $(jq -r --arg r "$rule" '.rules[$r]' "$tmp") == FAIL ]] && caught=1
    ;;
  forge)
    [[ -n "$test" ]] || { echo "no Forge test for $bug" >&2; exit 2; }
    forge test --match-path "${test%%:*}" --match-test "^${test#*:}\\(" -vv | tee "$tmp" || true
    grep -q "\[FAIL.*${test#*:}" "$tmp" && caught=1
    ;;
  *) echo "$usage" >&2; exit 2 ;;
esac

if [[ $caught == 1 ]]; then
  echo "Caught: $tool reports a violation with $bug applied."
  exit 0
fi
echo "Not caught: $tool passes with $bug applied." >&2
exit 1
