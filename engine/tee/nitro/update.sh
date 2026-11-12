#!/usr/bin/env bash
# Builds the enclave image from an engine image digest on the parent, runs it, boots it and
# records its measurements in eif.json.
#
#   update.sh sha256:<digest> [--hold]
#
# --hold leaves the enclave unbooted, with the proxy up, so it can be booted from outside.
# Reads KEELSON_TEE_TOKEN_SHA256 and KEELSON_ISSUER_JWK (the issuer's public key) from the
# environment, and optionally KEELSON_ORIGIN, KEELSON_CANONICALIZER, KEELSON_CHAIN_ID,
# KEELSON_BOND_VAULT and KEELSON_VERIFYING_CONTRACT, which default to leg A's values (the
# CREATE3 addresses of KeelsonBondVault and VerdictVerifier), and TEE_A_URL, whose /v1/health gives
# leg A's log keys and their KMS chains; the enclave checks each chain. With PAYPAL_LEGB_CLIENT_ID
# the enclave reads PayPal itself, with the secret sealed in /keelson/leg-b/paypal-secret-ct.
. "$(dirname "$0")/common.sh"

digest="${1:-}"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "usage: update.sh sha256:<digest> [--hold]" >&2; exit 1; }
hold="${2:-}"
: "${KEELSON_TEE_TOKEN_SHA256:?}" "${KEELSON_ISSUER_JWK:?}"

# Without leg A's log keys the enclave cannot verify the checkpoints leg A signs.
: "${TEE_A_URL:?the URL of leg A, to read its log keys}"
log_keys="$(curl -fsS "$TEE_A_URL/v1/health" | jq -c '[.log_keys // [] | .[] | select(.signature_chain) | {origin, public_key, signature_chain}]')"

id="$(instance_id)"
[ -n "$id" ] && [ "$(instance_state "$id")" = running ] || { echo "no running parent" >&2; exit 1; }

boot="$(jq -n \
  --arg digest "$digest" \
  --arg token "0x$KEELSON_TEE_TOKEN_SHA256" \
  --argjson issuer "$KEELSON_ISSUER_JWK" \
  --arg origin "${KEELSON_ORIGIN:-https://app.keelson.finance}" \
  --arg canonicalizer "${KEELSON_CANONICALIZER:-keelson-canon/0.0.0}" \
  --argjson chain "${KEELSON_CHAIN_ID:-421614}" \
  --arg vault "${KEELSON_BOND_VAULT:-0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf}" \
  --arg verifying "${KEELSON_VERIFYING_CONTRACT:-0xe16E8767EC1DA59Ef0D9Bc7851637E4D22352d96}" \
  --argjson log_keys "$log_keys" \
  --arg paypal "${PAYPAL_LEGB_CLIENT_ID:-}" \
  '{token_sha256: $token, config: {chain_id: $chain, bond_vault: $vault, verifying_contract: $verifying,
    oci_digest: $digest, canonicalizer: $canonicalizer, issuer: $issuer, origin: $origin, log_keys: $log_keys}}
    + (if $paypal == "" then {} else {paypal: {env: "sandbox", client_id: $paypal}} end)')"

# The enclave image is the engine image with the enclave's command. nitro-cli runs only the
# image's Cmd, so the entrypoint is cleared and the binary named in it. Its layers are the engine
# image's, so the measurements follow the digest.
remote="$(cat <<EOS
set -euo pipefail
$(unpack_parent)
bash /opt/keelson/parent/user-data.sh >/dev/null
install -d -m 0700 /etc/keelson
echo '$boot' > /etc/keelson/boot.json
chmod 0600 /etc/keelson/boot.json

docker pull --quiet $IMAGE@$digest >/dev/null
install -d /var/lib/keelson
rm -rf /opt/keelson/image && mkdir -p /opt/keelson/image
printf 'FROM $IMAGE@$digest\nENTRYPOINT []\nCMD ["/keelson-engine", "--platform", "nitro", "--listen", "vsock:5000"]\n' > /opt/keelson/image/Dockerfile
NITRO_CLI_ARTIFACTS=/var/lib/keelson NITRO_CLI_BLOBS=/usr/share/nitro_enclaves/blobs \
nitro-cli build-enclave --docker-dir /opt/keelson/image --docker-uri keelson-enclave:${digest:7:12} \
  --output-file /opt/keelson/keelson.eif >/opt/keelson/build.log 2>&1 || { cat /opt/keelson/build.log >&2; exit 1; }

systemctl stop caddy
started=\$(date +%s%N)
systemctl restart keelson-enclave
if [ "$hold" != --hold ]; then
  booted=\$(node /opt/keelson/parent/boot.ts /etc/keelson/boot.json)
  systemctl start caddy
else
  booted='{}'
  systemctl start caddy
fi
jq -nc --argjson eif "\$(nitro-cli describe-eif --eif-path /opt/keelson/keelson.eif)" \
  --argjson booted "\$booted" --arg cli "\$(nitro-cli --version)" \
  --argjson ms "\$(( (\$(date +%s%N) - started) / 1000000 ))" \
  '{eif: {Measurements: \$eif.Measurements}, booted: \$booted, nitro_cli: \$cli, restart_to_boot_ms: \$ms}'
EOS
)"

output="$(ssm_run "$id" "$remote")"
result="$(grep "^{" <<< "$output" | tail -n 1)"
echo "$result" | jq .
jq -n --argjson r "$result" --arg digest "$digest" --arg built "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{digest: $digest, pcr0: $r.eif.Measurements.PCR0, pcr1: $r.eif.Measurements.PCR1, pcr2: $r.eif.Measurements.PCR2,
    nitro_cli_version: $r.nitro_cli, built_at: $built}' > "$HERE/eif.json"
