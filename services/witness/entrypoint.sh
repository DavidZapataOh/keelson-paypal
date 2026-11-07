#!/bin/sh
# Starts a dedicated ssh-agent holding the witness key, registers the logs the
# witness cosigns, and runs litewitness. HTTPS is terminated in front of it.
#
#   WITNESS_NAME  name in the cosignature lines, e.g. witness-1.keelson.finance
#   WITNESS_KEY   OpenSSH Ed25519 private key
#   WITNESS_LOGS  origin=vkey pairs separated by ';' or newlines; defaults to
#                 the logs baked into the image
#   DB            SQLite database, on persistent storage
#   PORT          HTTP listener
set -eu

: "${WITNESS_NAME:?}" "${WITNESS_KEY:?}" "${DB:?}" "${PORT:?}"
logs=${WITNESS_LOGS:-$(cat /etc/litewitness/logs)}
sock=${LITEWITNESS_SOCK:-/run/litewitness.sock}

rm -f "$sock"
ssh-agent -D -a "$sock" >/dev/null &
while [ ! -S "$sock" ]; do sleep 0.1; done
key=$(mktemp)
printf '%s\n' "$WITNESS_KEY" >"$key"
SSH_AUTH_SOCK=$sock ssh-add -q "$key" 2>/dev/null
rm -f "$key"
unset WITNESS_KEY
fingerprint=$(SSH_AUTH_SOCK=$sock ssh-add -l -E sha256 | awk '{ print $2 }')

# Logs are never removed: re-adding one would start it again at size zero.
mkdir -p "$(dirname "$DB")"
known=$(witnessctl list-logs -db "$DB")
IFS='
'
for entry in $(printf '%s\n' "$logs" | tr ';' '\n'); do
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
