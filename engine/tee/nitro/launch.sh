#!/usr/bin/env bash
# Creates the parent: security group, instance role, the c6a.xlarge with enclaves enabled, an
# Elastic IP and the DNS record. Run it once; it refuses when a parent exists. Then run update.sh.
# Needs AWS_* and CLOUDFLARE_API_TOKEN in the environment.
. "$(dirname "$0")/common.sh"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"

[ -z "$(instance_id)" ] || { echo "a parent already exists: $(instance_id)" >&2; exit 1; }

vpc="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"

group="$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME" "Name=vpc-id,Values=$vpc" \
  --query 'SecurityGroups[0].GroupId' --output text)"
if [ "$group" = None ]; then
  group="$(aws ec2 create-security-group --group-name "$NAME" --vpc-id "$vpc" \
    --description "keelson leg B: http and https" --query GroupId --output text)"
  aws ec2 authorize-security-group-ingress --group-id "$group" \
    --ip-permissions 'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]' \
                     'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null
fi

if ! aws iam get-instance-profile --instance-profile-name keelson-tee-parent >/dev/null 2>&1; then
  aws iam create-role --role-name keelson-tee-parent --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name keelson-tee-parent \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam create-instance-profile --instance-profile-name keelson-tee-parent >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name keelson-tee-parent --role-name keelson-tee-parent
fi

ami="$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query Parameter.Value --output text)"
user_data="$(mktemp)"
trap 'rm -f "$user_data"' EXIT
{
  echo '#!/bin/bash'
  unpack_parent
  echo 'bash /opt/keelson/parent/user-data.sh'
} > "$user_data"

# A new instance profile can take a few seconds to be usable by EC2.
for attempt in 1 2 3 4 5 6; do
  id="$(aws ec2 run-instances --image-id "$ami" --instance-type c6a.xlarge --enclave-options Enabled=true \
    --iam-instance-profile Name=keelson-tee-parent --security-group-ids "$group" \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
    --user-data "file://$user_data" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text 2>/dev/null)" && break
  [ "$attempt" -lt 6 ] || { echo "run-instances failed" >&2; exit 1; }
  sleep 10
done
echo "instance $id"

# Whatever fails from here on leaves a parent that a retry must not duplicate: terminate it.
allocation=
undo() {
  aws ec2 terminate-instances --instance-ids "$id" >/dev/null
  echo "terminated $id" >&2
  if [ -n "$allocation" ]; then
    aws ec2 wait instance-terminated --instance-ids "$id"
    aws ec2 release-address --allocation-id "$allocation"
  fi
}
trap undo ERR
aws ec2 wait instance-running --instance-ids "$id"

allocation="$(aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" \
  --query AllocationId --output text)"
aws ec2 associate-address --instance-id "$id" --allocation-id "$allocation" >/dev/null
ip="$(aws ec2 describe-addresses --allocation-ids "$allocation" --query 'Addresses[0].PublicIp' --output text)"
echo "elastic ip $ip"

cloudflare() {
  curl -fsS -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") \
    -H 'Content-Type: application/json' "$@"
}
zone="$(cloudflare "https://api.cloudflare.com/client/v4/zones?name=$ZONE" | jq -r '.result[0].id')"
record="$(cloudflare "https://api.cloudflare.com/client/v4/zones/$zone/dns_records?type=A&name=$HOST" | jq -r '.result[0].id // empty')"
body="$(jq -n --arg name "$HOST" --arg ip "$ip" '{type: "A", name: $name, content: $ip, ttl: 60, proxied: false}')"
if [ -n "$record" ]; then
  cloudflare -X PUT -d "$body" "https://api.cloudflare.com/client/v4/zones/$zone/dns_records/$record" | jq -e .success >/dev/null
else
  cloudflare -X POST -d "$body" "https://api.cloudflare.com/client/v4/zones/$zone/dns_records" | jq -e .success >/dev/null
fi
echo "dns $HOST -> $ip"

wait_for_ssm "$id"
ssm_run "$id" 'cloud-init status --wait --long; test -x /usr/local/bin/caddy && nitro-cli --version'
trap - ERR
echo "ready: run update.sh sha256:<digest>"
