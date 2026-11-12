#!/bin/bash
# Installs and configures the parent. Idempotent: update.sh runs it again with the current files.
set -euo pipefail

CADDY_VERSION=2.11.9
CADDY_SHA512=0e85544340290a16ce4bfb76fe7d65e9de1bf3a6e67f5ccfff30b30d27ea4c73e078077b7bf3e58ae60b6b12e44327705287059c775bca5782e8ee85ea7edd75
NODE_VERSION=26.13.0
NODE_SHA256=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

dnf install -y aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel docker socat jq tar xz libatomic

if ! /usr/local/bin/caddy version 2>/dev/null | grep -q "^v$CADDY_VERSION "; then
  curl -fsSL -o "$tmp/caddy.tar.gz" \
    "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
  echo "$CADDY_SHA512  $tmp/caddy.tar.gz" | sha512sum --check --strict
  tar -xzf "$tmp/caddy.tar.gz" -C "$tmp" caddy
  install -m 0755 "$tmp/caddy" /usr/local/bin/caddy
fi
id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy

if ! /usr/local/bin/node --version 2>/dev/null | grep -qx "v$NODE_VERSION"; then
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum --check --strict
  tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'
fi

install -m 0644 "$here/allocator.yaml" /etc/nitro_enclaves/allocator.yaml
install -m 0644 "$here/vsock-proxy.yaml" /etc/nitro_enclaves/vsock-proxy.yaml
install -D -m 0644 "$here/Caddyfile" /etc/caddy/Caddyfile
for unit in keelson-vsock keelson-vsock-proxy keelson-enclave caddy; do
  install -m 0644 "$here/$unit.service" "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload

usermod -aG ne,docker ec2-user
systemctl enable --now docker nitro-enclaves-allocator.service keelson-vsock.service keelson-vsock-proxy.service
