"""Regenerates ``src/keelson/generated`` from ``openapi/keelson.yaml``.

The document is adapted first, without changing what it describes:

- every POST carries an Idempotency-Key, which the SDK's transport sets, so the header parameter is
  left out of the generated signatures;
- a nullable object (``type: [object, "null"]``) is written as ``anyOf`` an object and null, the
  form openapi-python-client reads;
- a path parameter is never null;
- a nullable object is a component of its own, referenced as that component or null;
- an inline object whose generated class name would be a component's is moved to components
  under its own name.

    uv run --group generate python scripts/generate.py
"""

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT.parents[1] / "openapi" / "keelson.yaml"
OUT = ROOT / "src" / "keelson" / "generated"


def pascal(name: str) -> str:
    return "".join(part[:1].upper() + part[1:] for part in name.replace("-", "_").split("_"))


def nullable_objects(node: object) -> object:
    if isinstance(node, list):
        return [nullable_objects(n) for n in node]
    if not isinstance(node, dict):
        return node
    node = {k: nullable_objects(v) for k, v in node.items()}
    kind = node.get("type")
    if isinstance(kind, list) and "null" in kind and ("object" in kind or "array" in kind):
        rest = {k: v for k, v in node.items() if k not in ("type", "description", "default")}
        shape = {"type": next(t for t in kind if t != "null"), **rest}
        meta = {k: node[k] for k in ("description", "default") if k in node}
        return {"anyOf": [shape, {"type": "null"}], **meta}
    return node


def hoist_colliding(schemas: dict[str, dict]) -> None:
    for name in list(schemas):
        for prop, schema in (schemas[name].get("properties") or {}).items():
            generated = f"{name}{pascal(prop)}"
            if schema.get("type") == "object" and "properties" in schema and generated in schemas:
                hoisted = f"{generated}Detail"
                schemas[hoisted] = schema
                schemas[name]["properties"][prop] = {"$ref": f"#/components/schemas/{hoisted}"}


def is_nullable_object(schema: object) -> bool:
    kind = schema.get("type") if isinstance(schema, dict) else None
    return isinstance(kind, list) and "null" in kind and "object" in kind and "properties" in schema


def hoist_nullable(schemas: dict[str, dict]) -> set[str]:
    """Makes every nullable object a component; returns the components that may be null."""
    nullable: set[str] = set()
    queue = list(schemas)
    while queue:
        name = queue.pop()
        schema = schemas[name]
        if is_nullable_object(schema):
            schema["type"] = "object"
            nullable.add(name)
        for prop, sub in (schema.get("properties") or {}).items():
            if is_nullable_object(sub):
                hoisted = f"{name}{pascal(prop)}"
                while hoisted in schemas:
                    hoisted += "Detail"
                description = sub.pop("description", None)
                sub["type"] = "object"
                schemas[hoisted] = sub
                ref: dict[str, object] = {"$ref": f"#/components/schemas/{hoisted}"}
                schema["properties"][prop] = {
                    "anyOf": [ref, {"type": "null"}],
                    **({"description": description} if description else {}),
                }
                queue.append(hoisted)
    return nullable


def nullable_refs(node: object, nullable: set[str]) -> object:
    """Writes a bare reference to a component that may be null as that component or null."""
    if isinstance(node, list):
        return [nullable_refs(n, nullable) for n in node]
    if not isinstance(node, dict):
        return node
    ref = node.get("$ref")
    if isinstance(ref, str) and ref.rsplit("/", 1)[-1] in nullable and len(node) == 1:
        return {"anyOf": [node, {"type": "null"}]}
    return {k: nullable_refs(v, nullable) for k, v in node.items()}


def adapt(spec: dict) -> dict:
    for path in spec["paths"].values():
        for op in path.values():
            params = [
                p
                for p in op.get("parameters", [])
                if not (p["in"] == "header" and p["name"].lower() == "idempotency-key")
            ]
            for p in params:
                kind = p["schema"].get("type")
                if p["in"] == "path" and isinstance(kind, list):
                    p["schema"]["type"] = next(t for t in kind if t != "null")
            if "parameters" in op:
                op["parameters"] = params
    hoist_colliding(spec["components"]["schemas"])
    nullable = hoist_nullable(spec["components"]["schemas"])
    return nullable_objects(nullable_refs(spec, nullable))  # type: ignore[return-value]


def main() -> None:
    spec = adapt(yaml.safe_load(SPEC.read_text()))
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "keelson.json"
        source.write_text(json.dumps(spec))
        shutil.rmtree(OUT, ignore_errors=True)
        subprocess.run(
            [
                "openapi-python-client",
                "generate",
                "--path",
                str(source),
                "--meta",
                "none",
                "--output-path",
                str(OUT),
                "--config",
                str(ROOT / "scripts" / "openapi-python-client.yaml"),
            ],
            check=True,
        )


if __name__ == "__main__":
    main()
