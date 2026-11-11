#!/bin/sh
# Writes src/keelson/_models.py from the developer subset of the OpenAPI document.
set -e
cd "$(dirname "$0")/.."
uv run --group dev datamodel-codegen \
  --input ../../openapi/keelson.public.json \
  --input-file-type openapi \
  --output src/keelson/_models.py \
  --output-model-type pydantic_v2.BaseModel \
  --use-annotated \
  --field-constraints \
  --use-standard-collections \
  --use-union-operator \
  --target-python-version 3.11 \
  --disable-timestamp \
  --use-double-quotes \
  --custom-file-header '"""Models generated from openapi/keelson.public.json; do not edit."""'
uv run --group dev ruff format -q src/keelson/_models.py
