#!/usr/bin/env bash
# Runs witness 3 as its own container on the leg B parent, served by the parent's Caddy at
# https://witness-3.keelson.finance. It touches only keelson-witness-3 and the Caddyfile, which
# Caddy reloads in place; the enclave, its units and the clock-drift job keep running.
# Usage: deploy.sh sha256:<digest>. Needs AWS_* in the environment.
. "$(dirname "$0")/../../../engine/tee/nitro/common.sh"

digest="${1:-}"
grep -Eq '^sha256:[0-9a-f]{64}$' <<< "$digest" || { echo "usage: deploy.sh sha256:<digest>" >&2; exit 2; }
image="ghcr.io/davidzapataoh/keelson-witness@$digest"
id="$(instance_id)"
[ -n "$id" ] || { echo "no parent instance" >&2; exit 1; }
unit="$(base64 < "$(dirname "$0")/keelson-witness-3.service" | tr -d '\n')"
caddyfile="$(base64 < "$HERE/parent/Caddyfile" | tr -d '\n')"

ssm_run "$id" "set -euo pipefail
legb() { nitro-cli describe-enclaves | jq -c '[.[] | {EnclaveID, State}]'; systemctl show -p Id -p ActiveEnterTimestamp keelson-enclave keelson-vsock keelson-clock-drift; }
before=\$(legb)
install -d -m 0700 /var/lib/keelson-witness-3
echo $unit | base64 -d > /etc/systemd/system/keelson-witness-3.service
echo IMAGE=$image > /etc/keelson-witness-3.env
docker pull --quiet $image > /dev/null
systemctl daemon-reload
systemctl enable --quiet keelson-witness-3
systemctl restart keelson-witness-3
for _ in \$(seq 30); do curl -fsS -o /dev/null http://127.0.0.1:7380/ && break; sleep 1; done
curl -fsS -o /dev/null http://127.0.0.1:7380/
tmp=\$(mktemp)
echo $caddyfile | base64 -d > \$tmp
/usr/local/bin/caddy validate --config \$tmp --adapter caddyfile 2>/dev/null
install -m 0644 \$tmp /etc/caddy/Caddyfile
rm -f \$tmp
if systemctl is-active --quiet caddy; then systemctl reload caddy; fi
systemctl is-active keelson-witness-3
after=\$(legb)
echo \"\$after\"
[ \"\$before\" = \"\$after\" ] || { echo 'leg B changed during the deploy' >&2; exit 1; }"
