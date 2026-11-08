#!/usr/bin/env bash
# Fails when the model checker reports a target that verification/smt-accepted.txt does not list. Each accepted line is
# `<file>:<line>:<column> <warning code>  # reason`; code 5724 (unsupported language features) is listed once, by code.
#
#   script/smt-gate.sh smt.log verification/smt-accepted.txt
set -euo pipefail

log=${1:?smt.log}
accepted=${2:?accepted list}

grep -q "Compiler run successful" "$log" || { echo "The model checker build failed." >&2; exit 1; }

open=$(awk '
  # A warning without a source location (no solver, CHC not run, a global summary) is reported by its code alone.
  function flush() { if (pending) print code; pending = 0 }
  /^Warning \([0-9]+\): (CHC|BMC|SMTChecker)/ { flush(); code = $2; gsub(/[():]/, "", code); pending = 1; next }
  /^Warning/ { flush(); next }
  pending && /-->/ { loc = $2; sub(/:$/, "", loc); print loc " " code; pending = 0 }
  END { flush() }
' "$log" | sort -u | while IFS= read -r target; do
  grep -qE "^${target//./\\.}( |$)" "$accepted" || echo "$target"
done)

if [[ -n "$open" ]]; then
  echo "Model checker targets not accepted:" >&2
  echo "$open" >&2
  exit 1
fi
echo "Model checker: every reported target is accepted."
