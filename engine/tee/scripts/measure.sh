#!/usr/bin/env bash
# Reproduces the measurements of both legs from source.
#
#   measure.sh oci | tdx | nitro | assemble
#
# Needs Linux, Docker with buildx, curl, jq, tar and Node (see .node-version), and about 20 GB
# free. Reads OCI_DIGEST, INSTANCE_TYPE, APP_ID, OS_IMAGE and OUT from the environment (Makefile).
set -euo pipefail

tee_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(cd "$tee_dir/../.." && pwd)"
out="${OUT:-$tee_dir/out}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

: "${OCI_DIGEST:?}" "${INSTANCE_TYPE:?}" "${OS_IMAGE:?}" "${APP_ID:?}"

IMAGE=ghcr.io/davidzapataoh/keelson-engine
BUILDKIT_IMAGE=moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe
RUST_IMAGE=docker.io/library/rust:1.99.1-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c
AL2023_IMAGE=public.ecr.aws/amazonlinux/amazonlinux:2023.12.20261102.0@sha256:381352c430f36d8aa6b8b670de06e7e4e5642fe0cb9dbd463bb8d1e79aefc0c7
NITRO_CLI_PACKAGE=aws-nitro-enclaves-cli-1.5.0-0.amzn2023

# The blobs nitro-cli 1.5.0 builds every enclave image from.
NITRO_BLOBS_SHA256="210eda749c1308eb60671a579d24db5e8a3477cb7a247cf313c286b09fe2d857  bzImage
10d7d9dd205d4596d45997d17434f26207525f129d171a51f9859b1af9f4a07a  cmdline
c4acb866e8925c171b43517f3a88a6989f5a2da3a6d3e6594f75bedc6d116a27  init
e57bb1779b348da7eae118a8e0a034d2aa4c28205c07db07dea8285ff206bb69  linuxkit
6bd2b09422c2f2f58c6ecf1cfd55216bea9b99a6d591261a9eca40027291316b  nsm.ko"

oci() {
  # The image's creation time is the SOURCE_DATE_EPOCH it was built with, so rebuilding the
  # published digest needs the same one.
  local epoch="${SOURCE_DATE_EPOCH:-}"
  if [ -z "$epoch" ]; then
    local created
    created="$(docker buildx imagetools inspect "$IMAGE@$OCI_DIGEST" --format '{{json .Image}}' \
      | jq -r 'if has("created") then .created else (to_entries[0].value.created) end')"
    epoch="$(date -u -d "$created" +%s)"
  fi
  echo "SOURCE_DATE_EPOCH=$epoch"

  docker buildx inspect keelson-measure >/dev/null 2>&1 \
    || docker buildx create --name keelson-measure --driver docker-container \
      --driver-opt "image=$BUILDKIT_IMAGE" >/dev/null
  rm -rf "$out/oci" && mkdir -p "$out/oci"
  (
    cd "$root"
    SOURCE_DATE_EPOCH="$epoch" docker buildx build --builder keelson-measure \
      -f engine/tee/Containerfile . \
      --no-cache \
      --platform linux/amd64 \
      --build-arg BUILDKIT_MULTI_PLATFORM=1 \
      --build-arg SOURCE_DATE_EPOCH \
      --provenance=false \
      --sbom=false \
      --output "type=oci,rewrite-timestamp=true,force-compression=true,dest=$out/oci/keelson-engine.tar"
  )
  mkdir "$out/oci/layout"
  tar -xf "$out/oci/keelson-engine.tar" -C "$out/oci/layout"
  local built
  built="$(jq -r '.manifests[0].digest' "$out/oci/layout/index.json")"
  rm -rf "$out/oci/layout"
  echo "built $built"
  if [ "$built" != "$OCI_DIGEST" ]; then
    echo "FAIL the source builds $built, not $OCI_DIGEST" >&2
    exit 1
  fi
  echo "$built" > "$out/oci-digest"
}

tdx() {
  local entry release sha256 revision
  entry="$(jq -e --arg os "$OS_IMAGE" '.[$os]' "$tee_dir/phala/os-images.json")"
  release="$(jq -r .release <<< "$entry")"
  sha256="$(jq -r .sha256 <<< "$entry")"
  revision="$(jq -r .revision <<< "$entry")"

  rm -rf "$out/tdx" && mkdir -p "$out/tdx/os"
  curl -fsSL -o "$out/tdx/$OS_IMAGE.tar.gz" \
    "https://github.com/Dstack-TEE/dstack/releases/download/$release/$OS_IMAGE.tar.gz"
  echo "$sha256  $out/tdx/$OS_IMAGE.tar.gz" | sha256sum --check --strict
  tar -xzf "$out/tdx/$OS_IMAGE.tar.gz" -C "$out/tdx/os"
  rm "$out/tdx/$OS_IMAGE.tar.gz"
  local image_dir
  image_dir="$(dirname "$(find "$out/tdx/os" -name metadata.json | head -n 1)")"

  # The CVM sizes Phala sells: vCPUs and memory.
  local cpu memory
  case "$INSTANCE_TYPE" in
    tdx.small) cpu=1 memory=2147483648 ;;
    tdx.medium) cpu=2 memory=4294967296 ;;
    tdx.large) cpu=4 memory=8589934592 ;;
    *) echo "unknown instance type $INSTANCE_TYPE" >&2; exit 1 ;;
  esac
  jq --argjson cpu "$cpu" --argjson memory "$memory" --arg image "$OS_IMAGE" \
    --arg hash "$(jq -r ".[\"$OS_IMAGE\"].os_image_hash" "$tee_dir/phala/os-images.json")" \
    '{os_image_hash: $hash, cpu_count: $cpu, memory_size: $memory, image: $image} + .' \
    "$tee_dir/phala/vm-config.json" > "$out/tdx/vm-config.json"

  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e CARGO_HOME=/tmp/cargo \
    -e REVISION="$revision" -e IMAGE_DIR="/out/${image_dir#"$out/tdx/"}" \
    -v "$out/tdx:/out" "$RUST_IMAGE" bash -euc '
      git init -q /tmp/dstack
      git -C /tmp/dstack fetch -q --depth 1 https://github.com/Dstack-TEE/dstack "$REVISION"
      git -C /tmp/dstack checkout -q FETCH_HEAD
      cd /tmp/dstack/dstack
      cargo build --locked --release -p dstack-mr-cli
      target/release/dstack-mr diagnose --json --vm-config /out/vm-config.json \
        --image-dir "$IMAGE_DIR" > /out/registers.json
    '
}

nitro() {
  rm -rf "$out/nitro" && mkdir -p "$out/nitro/context"
  docker pull --quiet "$IMAGE@$OCI_DIGEST" >/dev/null
  printf 'FROM %s@%s\nENTRYPOINT []\nCMD ["/keelson-engine", "--platform", "nitro", "--listen", "vsock:5000"]\n' \
    "$IMAGE" "$OCI_DIGEST" > "$out/nitro/context/Dockerfile"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$out/nitro:/out" \
    -e PACKAGE="$NITRO_CLI_PACKAGE" -e BLOBS="$NITRO_BLOBS_SHA256" -e TAG="keelson-enclave:${OCI_DIGEST:7:12}" \
    "$AL2023_IMAGE" bash -euc '
      dnf install -y -q "$PACKAGE" docker >/dev/null
      (cd /usr/share/nitro_enclaves/blobs && echo "$BLOBS" | sha256sum --check --strict --quiet)
      nitro-cli --version > /out/version
      NITRO_CLI_ARTIFACTS=/tmp/artifacts nitro-cli build-enclave --docker-dir /out/context \
        --docker-uri "$TAG" --output-file /out/keelson.eif > /out/build.log
      nitro-cli describe-eif --eif-path /out/keelson.eif > /out/eif.json
    '
  jq -e '.Measurements | has("PCR0", "PCR1", "PCR2")' "$out/nitro/eif.json" >/dev/null
}

assemble() {
  (cd "$tee_dir" && node scripts/measurements.ts "$out" "$tee_dir/phala")
}

case "${1:-}" in
  oci | tdx | nitro | assemble) "$1" ;;
  *) echo "usage: measure.sh oci | tdx | nitro | assemble" >&2; exit 1 ;;
esac
