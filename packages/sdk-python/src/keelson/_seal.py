from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from typing import Any

from ._jcs import canonical_bytes

MEDIA_TYPES = {
    "api.product": "application/json",
    "api.cart": "application/json",
    "llm.observation": "text/plain; charset=utf-8",
}
_DST = b"keelson/evidence-item/v1"


@dataclass
class SealedItem:
    type: str
    media_type: str
    content: bytes
    salt: bytes


def sealed_items(sources: dict[str, Any], salts: list[bytes] | None = None) -> list[SealedItem]:
    """The items to seal from what the agent saw, each with its own 32-byte salt."""
    observation = sources.get("observation")
    if not observation:
        raise TypeError("an observation is required")
    raw: list[tuple[str, bytes]] = []
    if sources.get("product") is not None:
        raw.append(("api.product", canonical_bytes(sources["product"])))
    if sources.get("cart") is not None:
        raw.append(("api.cart", canonical_bytes(sources["cart"])))
    raw.append(("llm.observation", str(observation).encode()))
    salts = salts or []
    return [
        SealedItem(t, MEDIA_TYPES[t], b, salts[i] if i < len(salts) else os.urandom(32)) for i, (t, b) in enumerate(raw)
    ]


def _leaf(item: SealedItem) -> bytes:
    return hashlib.sha256(
        b"\x00"
        + _DST
        + item.salt
        + item.type.encode()
        + b"\x00"
        + item.media_type.encode()
        + b"\x00"
        + hashlib.sha256(item.content).digest()
    ).digest()


def _root(leaves: list[bytes]) -> bytes:
    if len(leaves) == 1:
        return leaves[0]
    k = 1
    while k << 1 < len(leaves):
        k <<= 1
    return hashlib.sha256(b"\x01" + _root(leaves[:k]) + _root(leaves[k:])).digest()


def manifest_of(items: list[SealedItem]) -> dict[str, Any]:
    """The public manifest of the sealed items and its ``evidenceRoot`` (RFC 6962 §2.1)."""
    leaves = [_leaf(i) for i in items]
    return {
        "v": "keelson.manifest/1",
        "root": "0x" + _root(leaves).hex(),
        "items": [
            {"type": i.type, "media_type": i.media_type, "leaf": "0x" + leaf.hex()}
            for i, leaf in zip(items, leaves, strict=True)
        ],
    }
