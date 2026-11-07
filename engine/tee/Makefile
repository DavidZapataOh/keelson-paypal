# Reproduces measurements.json from source. Run it on Linux with Docker; see README.md.
#
#   make measure [OCI_DIGEST=sha256:...] [INSTANCE_TYPE=tdx.small] [APP_ID=...] [OS_IMAGE=dstack-0.6.1]
#
# OCI_DIGEST defaults to the digest phala/docker-compose.yml pins. The build fails if the source
# does not produce it.

OUT ?= $(CURDIR)/out
OCI_DIGEST ?= $(shell grep -Eo 'sha256:[0-9a-f]{64}' phala/docker-compose.yml | head -n 1)
INSTANCE_TYPE ?= tdx.small
APP_ID ?= $(shell jq -r .app_id phala/app.json)
OS_IMAGE ?= dstack-0.6.1

export OUT OCI_DIGEST INSTANCE_TYPE APP_ID OS_IMAGE

.PHONY: measure oci tdx nitro
measure: oci tdx nitro
	scripts/measure.sh assemble

oci tdx nitro:
	scripts/measure.sh $@
