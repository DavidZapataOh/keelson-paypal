#!/bin/sh
# Starts a dedicated ssh-agent holding the witness key, registers the logs the
# witness cosigns, and runs litewitness. HTTPS is terminated in front of it.
#
#   WITNESS_NAME  name in the cosignature lines, e.g. witness-1.keelson.finance
#   WITNESS_KEY   OpenSSH Ed25519 private key
#   WITNESS_LOGS  origin=vkey pairs separated by ';'
#   DB            SQLite database, on persistent storage
#   PORT          HTTP listener
set -eu

: "${WITNESS_NAME:?}" "${WITNESS_KEY:?}" "${WITNESS_LOGS:?}" "${DB:?}" "${PORT:?}"
sock=${LITEWITNESS_SOCK:-/run/litewitness.sock}

rm -f "$sock"
eval "$(ssh-agent -s -a "$sock")" >/dev/null
key=$(mktemp)
printf '%s\n' "$WITNESS_KEY" >"$key"
SSH_AUTH_SOCK=$sock ssh-add -q "$key" 2>/dev/null
rm -f "$key"
unset WITNESS_KEY
fingerprint=$(SSH_AUTH_SOCK=$sock ssh-add -l -E sha256 | awk '{ print $2 }')

# Logs are never removed: re-adding one would start it again at size zero.
mkdir -p "$(dirname "$DB")"
known=$(witnessctl list-logs -db "$DB")
IFS=';'
for entry in $WITNESS_LOGS; do
	origin=${entry%%=*}
	vkey=${entry#*=}
	case $known in
	*"\"origin\":\"$origin\""*) ;;
	*) witnessctl add-log -db "$DB" -origin "$origin" ;;
	esac
	case $known in
	*"\"$vkey\""*) ;;
	*) witnessctl add-key -db "$DB" -origin "$origin" -key "$vkey" ;;
	esac
done
unset IFS

exec litewitness -db "$DB" -name "$WITNESS_NAME" -key "$fingerprint" \
	-ssh-agent "$sock" -listen "0.0.0.0:$PORT"
