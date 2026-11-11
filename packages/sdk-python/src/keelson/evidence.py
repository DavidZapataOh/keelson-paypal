"""Sealed evidence and the cart hash, byte for byte as Keelson computes them."""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

import rfc8785

ITEM_TYPES = (
    "api.product",
    "api.cart",
    "llm.observation",
    "dom.snapshot",
    "ax.tree",
    "hidden.text",
    "screenshot",
    "mhtml",
    "har",
    "channel3.observation",
    "tlsn.web_fact",
    "api.checkout",
)
"""The public item types, in manifest order."""

MEDIA_TYPES = {
    "api.product": "application/json",
    "api.cart": "application/json",
    "llm.observation": "text/plain; charset=utf-8",
    "dom.snapshot": "application/vnd.keelson.dom.v1+json",
    "ax.tree": "application/json",
    "hidden.text": "application/json",
    "screenshot": "image/png",
    "mhtml": "multipart/related",
    "har": "application/json",
    "channel3.observation": "application/json",
    "tlsn.web_fact": "application/json",
    "api.checkout": "application/json",
}

_EVIDENCE_ITEM = b"keelson/evidence-item/v1"
_CART = b"keelson/cart/v1"


class CartLine(TypedDict, total=False):
    sku: str
    size: str | None
    color: str | None
    category: str
    qty: int
    unit_minor: int


class Cart(TypedDict):
    """A cart as Keelson's engine reads it: the store's answer, prices included."""

    merchant: str
    currency: str
    lines: list[CartLine]
    return_days: int
    returns_free: bool


def jcs(value: Any) -> bytes:
    """RFC 8785 canonical JSON."""
    return rfc8785.dumps(value)


def cart_hash(cart: Cart) -> str:
    """``sha256:<hex>`` of ``"keelson/cart/v1" || 0x00 || JCS(cart)``, an absent size or color
    as null: what the agent signs as ``cart_hash`` when it closes the mandate."""
    canonical = {
        "merchant": cart["merchant"],
        "currency": cart["currency"],
        "lines": [
            {
                "sku": line["sku"],
                "size": line.get("size"),
                "color": line.get("color"),
                "category": line["category"],
                "qty": line["qty"],
                "unit_minor": line["unit_minor"],
            }
            for line in cart["lines"]
        ],
        "return_days": cart["return_days"],
        "returns_free": cart["returns_free"],
    }
    return "sha256:" + hashlib.sha256(_CART + b"\x00" + jcs(canonical)).hexdigest()


@dataclass(frozen=True)
class SealedItem:
    type: str
    media_type: str
    data: bytes
    salt: bytes = field(default_factory=lambda: secrets.token_bytes(32))


def _ascii(value: str) -> bytes:
    if not value or any(not 0x20 <= ord(c) <= 0x7E for c in value):
        raise ValueError("type and media type must be non-empty printable ASCII")
    return value.encode()


def item_leaf(item: SealedItem) -> bytes:
    """``SHA-256(0x00 || "keelson/evidence-item/v1" || salt || type || 0x00 || media_type || 0x00
    || SHA-256(data))``."""
    if len(item.salt) != 32:
        raise ValueError("salt must be 32 bytes")
    return hashlib.sha256(
        b"\x00"
        + _EVIDENCE_ITEM
        + item.salt
        + _ascii(item.type)
        + b"\x00"
        + _ascii(item.media_type)
        + b"\x00"
        + hashlib.sha256(item.data).digest()
    ).digest()


def _node(left: bytes, right: bytes) -> bytes:
    return hashlib.sha256(b"\x01" + left + right).digest()


def tree_root(leaves: Sequence[bytes]) -> bytes:
    """RFC 6962 §2.1 Merkle Tree Hash over leaf hashes."""
    if not leaves:
        raise ValueError("a tree needs at least one leaf")
    if len(leaves) == 1:
        return leaves[0]
    k = 1
    while k << 1 < len(leaves):
        k <<= 1
    return _node(tree_root(leaves[:k]), tree_root(leaves[k:]))


def _rank(kind: str) -> int:
    original = kind.endswith(".original")
    base = kind.removesuffix(".original")
    if base not in ITEM_TYPES:
        return -1
    i = ITEM_TYPES.index(base)
    return len(ITEM_TYPES) + i if original else i


class ManifestEntry(TypedDict):
    type: str
    media_type: str
    leaf: str


class Manifest(TypedDict):
    v: Literal["keelson.manifest/1"]
    root: str
    items: list[ManifestEntry]


def build_manifest(items: Sequence[SealedItem]) -> Manifest:
    """The public manifest and its ``root``, the evidence root countersigns are asked under."""
    if not items:
        raise ValueError("a manifest needs at least one item")
    if len({i.salt for i in items}) != len(items):
        raise ValueError("every item needs its own salt")
    ranks = [_rank(i.type) for i in items]
    if min(ranks) < 0 or ranks != sorted(set(ranks)):
        raise ValueError("items must be known types, in manifest order, without duplicates")
    leaves = [item_leaf(i) for i in items]
    return {
        "v": "keelson.manifest/1",
        "root": "0x" + tree_root(leaves).hex(),
        "items": [
            {"type": i.type, "media_type": i.media_type, "leaf": "0x" + leaf.hex()}
            for i, leaf in zip(items, leaves, strict=True)
        ],
    }


def seal(product: Any, cart: Cart, observation: str) -> list[SealedItem]:
    """The items of one cart's evidence: the store's product and cart answers and what the agent
    read, verbatim, each with a fresh salt."""
    return [
        SealedItem("api.product", MEDIA_TYPES["api.product"], jcs(product)),
        SealedItem("api.cart", MEDIA_TYPES["api.cart"], jcs(cart)),
        SealedItem("llm.observation", MEDIA_TYPES["llm.observation"], observation.encode()),
    ]
