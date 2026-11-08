#!/usr/bin/env bash
# Creates the relayer's secp256k1 KMS keys and the IAM user that may only sign with them.
# Idempotent: existing aliases, the user and its policy are reused. Run with administrator credentials.
# With RELAYER_ENV_FILE set and no access key on the user yet, creates one and appends it to that file.
set -euo pipefail

region="${AWS_REGION:-us-west-2}"
user="keelson-relayer"
aliases=(alias/keelson-relayer-arbitrum-sepolia alias/keelson-relayer-arbitrum-one)
account="$(aws sts get-caller-identity --query Account --output text)"

arns=()
for alias in "${aliases[@]}"; do
  arn="$(aws kms describe-key --region "$region" --key-id "$alias" --query KeyMetadata.Arn --output text 2>/dev/null || true)"
  if [[ -z "$arn" ]]; then
    arn="$(aws kms create-key --region "$region" \
      --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY \
      --description "Keelson relayer (${alias#alias/keelson-relayer-})" \
      --tags TagKey=service,TagValue=keelson-relayer \
      --query KeyMetadata.Arn --output text)"
    aws kms create-alias --region "$region" --alias-name "$alias" --target-key-id "$arn"
  fi
  arns+=("$arn")
done

aws iam get-user --user-name "$user" >/dev/null 2>&1 || aws iam create-user --user-name "$user" >/dev/null
policy="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "kms:GetPublicKey",
      "Resource": ["${arns[0]}", "${arns[1]}"]
    },
    {
      "Effect": "Allow",
      "Action": "kms:Sign",
      "Resource": ["${arns[0]}", "${arns[1]}"],
      "Condition": {
        "StringEquals": { "kms:SigningAlgorithm": "ECDSA_SHA_256", "kms:MessageType": "DIGEST" }
      }
    }
  ]
}
JSON
)"
aws iam put-user-policy --user-name "$user" --policy-name keelson-relayer-sign --policy-document "$policy"

if [[ -n "${RELAYER_ENV_FILE:-}" ]] && [[ "$(aws iam list-access-keys --user-name "$user" --query 'length(AccessKeyMetadata)')" == "0" ]]; then
  aws iam create-access-key --user-name "$user" \
    --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text |
    awk '{ printf "RELAYER_AWS_ACCESS_KEY_ID=%s\nRELAYER_AWS_SECRET_ACCESS_KEY=%s\n", $1, $2 }' >>"$RELAYER_ENV_FILE"
fi

echo "account ${account} region ${region} user ${user}"
for i in 0 1; do
  der="$(aws kms get-public-key --region "$region" --key-id "${arns[$i]}" --query PublicKey --output text)"
  # The last 64 bytes of the SPKI DER are the uncompressed point's x ‖ y.
  address="$(node -e '
    const { keccak256, getAddress } = require("viem");
    const der = Buffer.from(process.argv[1], "base64");
    const xy = der.subarray(der.length - 64);
    console.log(getAddress(`0x${keccak256(xy).slice(-40)}`));
  ' "$der")"
  echo "${aliases[$i]} ${arns[$i]} ${address}"
done
