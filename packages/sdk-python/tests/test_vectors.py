from __future__ import annotations

import json
from pathlib import Path

import keelson
from keelson import canonical_bytes, cart_hash, close_mandate, import_agent_key, manifest_of, sealed_items

V = json.loads((Path(__file__).parent / "vectors.json").read_text())


def test_canonical_bytes_match_typescript() -> None:
    assert canonical_bytes(V["product"]).hex() == V["canonical"]["product"]


def test_cart_hash_matches_typescript() -> None:
    assert cart_hash(V["cart"]) == V["cartHash"]


def test_manifest_and_root_match_typescript() -> None:
    items = sealed_items(
        {"product": V["product"], "cart": V["cart"], "observation": V["observation"]},
        [bytes([1]) * 32, bytes([2]) * 32, bytes([3]) * 32],
    )
    assert manifest_of(items) == V["manifest"]


def test_closing_a_mandate_matches_typescript() -> None:
    c = V["close"]
    key = import_agent_key(c["jwk"])
    closed = close_mandate(c["open"], request_id=c["requestId"], cart=V["cart"], key=key, iat=c["iat"])
    assert ".".join(closed[len(c["open"]) :].split(".")[:2]) == c["keyBinding"]


def test_tools_match_typescript() -> None:
    mine = [
        {"name": t.name, "readOnly": t.read_only, "inputSchema": t.input_schema}
        for t in keelson.tools(keelson.AsyncKeelson(None))
    ]
    assert mine == V["tools"]
