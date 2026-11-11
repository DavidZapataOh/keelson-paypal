import json
from pathlib import Path

from keelson import SealedItem, build_manifest, cart_hash
from keelson.evidence import MEDIA_TYPES, jcs
from keelson.money import to_paypal_value
from keelson.ulid import new_ulid

# Computed by Keelson's TypeScript packages (@keelson/core, @keelson/evidence) for these inputs.
VECTORS = json.loads((Path(__file__).parent / "vectors.json").read_text())


def test_cart_hash_matches_keelson():
    assert cart_hash(VECTORS["cart"]) == VECTORS["cartHash"]


def test_an_absent_size_or_color_hashes_as_null():
    cart = json.loads(json.dumps(VECTORS["cart"]))
    with_null = json.loads(json.dumps(cart))
    with_null["lines"][0]["color"] = None
    del cart["lines"][0]["color"]
    assert cart_hash(cart) == cart_hash(with_null)


def test_manifest_matches_keelson():
    items = [
        SealedItem(
            "api.product", MEDIA_TYPES["api.product"], jcs(VECTORS["product"]), bytes([1]) * 32
        ),
        SealedItem("api.cart", MEDIA_TYPES["api.cart"], jcs(VECTORS["cart"]), bytes([2]) * 32),
        SealedItem(
            "llm.observation",
            MEDIA_TYPES["llm.observation"],
            b"Tempo 3, size 9, $129.00.",
            bytes([3]) * 32,
        ),
    ]
    assert build_manifest(items) == VECTORS["manifest"]


def test_manifest_refuses_items_out_of_order_or_sharing_a_salt():
    a = SealedItem("api.cart", "application/json", b"{}", bytes([1]) * 32)
    b = SealedItem("api.product", "application/json", b"{}", bytes([2]) * 32)
    for items in ([a, b], [b, SealedItem("api.cart", "application/json", b"{}", b.salt)]):
        try:
            build_manifest(items)
        except ValueError:
            continue
        raise AssertionError("accepted")


def test_paypal_values():
    assert to_paypal_value("USD", 12900) == "129.00"
    assert to_paypal_value("USD", 5) == "0.05"
    assert to_paypal_value("JPY", 940) == "940"
    assert to_paypal_value("HUF", 9400) == "94"


def test_ulids_sort_by_time_and_use_crockford():
    first, second = new_ulid(), new_ulid()
    assert len(first) == 26 and first[0] in "01234567"
    assert set(first) <= set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    assert first[:10] <= second[:10]
