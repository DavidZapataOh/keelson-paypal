#!/bin/sh
# Starts a dedicated ssh-agent holding the witness key, registers the logs the
# witness cosigns, and runs litewitness. HTTPS is terminated in front of it.
#
#   WITNESS_NAME  name in the cosignature lines, e.g. witness-1.keelson.finance
#   WITNESS_KEY   OpenSSH Ed25519 private key
#   WITNESS_LOGS  origin=vkey pairs separated by ';' or newlines; defaults to
#                 the logs baked into the image. An origin may be listed with
#                 several keys; a key no longer listed for an origin is deleted
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
	*)
		witnessctl add-log -db "$DB" -origin "$origin"
		known="$known
\"origin\":\"$origin\""
		;;
	esac
	case $known in
	*"\"$vkey\""*) ;;
	*) witnessctl add-key -db "$DB" -origin "$origin" -key "$vkey" ;;
	esac
done
# Keys of a listed origin that are no longer listed, such as a log key that
# moved, are deleted: the witness then refuses checkpoints signed with them.
known=$(witnessctl list-logs -db "$DB")
for line in $known; do
	origin=$(printf '%s' "$line" | sed -n 's/.*"origin":"\([^"]*\)".*/\1/p')
	wanted=$(printf '%s\n' "$logs" | tr ';' '\n' | sed -n "s|^$origin=||p")
	[ -n "$wanted" ] || continue
	for vkey in $(printf '%s' "$line" | sed -n 's/.*"keys":\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | tr -d '"'); do
		case "
$wanted
" in
		*"
$vkey
"*) ;;
		*) witnessctl del-key -db "$DB" -origin "$origin" -key "$vkey" ;;
		esac
	done
done
unset IFS

exec litewitness -db "$DB" -name "$WITNESS_NAME" -key "$fingerprint" \
	-ssh-agent "$sock" -listen "0.0.0.0:$PORT"
