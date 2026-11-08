#!/usr/bin/env bash
# Fails if a Certora harness could change the behavior of the contract it wraps, or if a Certora conf compiles with
# settings other than the production profile in foundry.toml.
set -euo pipefail

cd "$(dirname "$0")/.."
status=0

fail() {
  echo "check-harness: $*" >&2
  status=1
}

for file in certora/harness/*.sol; do
  if grep -nw 'override' "$file" >/dev/null; then
    fail "$file: declares an override"
  fi
  if grep -nE '^[[:space:]]*(modifier|receive|fallback)\b' "$file" >/dev/null; then
    fail "$file: declares a modifier, receive or fallback"
  fi
  if perl -0ne 'exit((/constructor\s*\([^{]*\{\s*[^}\s]/s) ? 0 : 1)' "$file"; then
    fail "$file: constructor has a body; it may only pass arguments to its parent"
  fi
  # In the contract body every declaration ending in ';' is a state variable, and every function must be a view or
  # pure getter or a one-line call to an internal function of the parent.
  awk -v file="$file" '
    function report(msg) { print "check-harness: " file ":" NR ": " msg > "/dev/stderr"; bad = 1 }
    function check(text,   head, body) {
      head = text
      sub(/\{.*/, "", head)
      if (head ~ /[ )](view|pure)( |$)/) return
      body = text
      sub(/^[^{]*\{/, "", body)
      sub(/\}[ \t]*$/, "", body)
      gsub(/^[ \t]+|[ \t]+$/, "", body)
      if (body !~ /^(return )?_[A-Za-z0-9_]*\([^;]*\);$/) report("non-view function is not a one-line internal call: " body)
    }
    {
      line = $0
      sub(/\/\/.*/, "", line)
      trimmed = line
      gsub(/^[ \t]+|[ \t]+$/, "", trimmed)
      if (!inFunction && depth == 1 && trimmed != "") {
        if (trimmed ~ /^function /) { inFunction = 1; text = "" }
        else if (trimmed ~ /;$/ && trimmed !~ /^(event|error|using) /) report("declares state: " trimmed)
      }
      if (inFunction) text = text " " trimmed
      n = split(line, chars, "")
      for (i = 1; i <= n; i++) {
        if (chars[i] == "{") depth++
        else if (chars[i] == "}") {
          depth--
          if (inFunction && depth == 1) { check(text); inFunction = 0 }
        }
      }
    }
    END { exit bad }
  ' "$file" || status=1
done

profile=$(awk '/^\[profile\.default\]/ { on = 1; next } /^\[/ { on = 0 } on' foundry.toml)
value() { echo "$profile" | sed -n "s/^$1 *= *\"\{0,1\}\([^\"]*\)\"\{0,1\} *$/\1/p"; }
solc=$(value solc)
via_ir=$(value via_ir)
optimizer=$(value optimizer)
runs=$(value optimizer_runs)
evm=$(value evm_version)
[ "$optimizer" = true ] || fail "foundry.toml: optimizer is not enabled"

for conf in certora/conf/*.conf; do
  setting() { jq -r ".$1 | tostring" "$conf"; }
  [ "$(setting solc)" = "solc$solc" ] || fail "$conf: solc $(setting solc) differs from solc$solc"
  [ "$(setting solc_via_ir)" = "$via_ir" ] || fail "$conf: solc_via_ir $(setting solc_via_ir) differs from $via_ir"
  [ "$(setting solc_optimize)" = "$runs" ] || fail "$conf: solc_optimize $(setting solc_optimize) differs from $runs"
  [ "$(setting solc_evm_version)" = "$evm" ] || fail "$conf: solc_evm_version $(setting solc_evm_version) differs from $evm"
done

exit "$status"
