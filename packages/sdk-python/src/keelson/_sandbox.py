from __future__ import annotations

import re
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx2

from ._errors import KeelsonError

SANDBOX_STORE = "https://store.keelson.finance"


async def quote(lines: list[dict[str, Any]], *, store: str = SANDBOX_STORE) -> dict[str, Any]:
    """Prices a cart from the sandbox store itself.

    Each product is read from its page's URL and the cart, prices included, is the store's own
    answer. Returns ``{"cart", "total", "sources"}``: the cart to countersign and the store's
    answers to seal as evidence.
    """
    u = urlsplit(store)
    origin = f"{u.scheme}://{u.netloc}"
    if origin != SANDBOX_STORE and u.hostname not in ("localhost", "127.0.0.1"):
        raise KeelsonError(f"quote() prices carts on {SANDBOX_STORE} only.")
    products: list[dict[str, Any]] = []
    async with httpx2.AsyncClient(timeout=30.0) as client:

        async def get(path: str, what: str) -> Any:
            res = await client.get(f"{origin}{path}")
            if res.status_code >= 400:
                raise KeelsonError(f"The store did not answer the {what}: HTTP {res.status_code}.")
            return res.json()

        for line in lines:
            url = urlsplit(urljoin(origin + "/", line["productUrl"]))
            if f"{url.scheme}://{url.netloc}" != origin:
                raise KeelsonError("A product is not on the store.")
            listing = re.fullmatch(r"/l/([A-Za-z0-9_-]{22})", url.path)
            handle = re.fullmatch(r"/products/([a-z0-9-]{1,64})", url.path)
            if listing:
                products.append((await get(f"/api/listings/{listing.group(1)}", "listing"))["product"])
            elif handle:
                products.append(await get(f"/api/products/{handle.group(1)}", "product"))
            else:
                raise KeelsonError(f"Not a product page: {line['productUrl']}")
        res = await client.post(
            f"{origin}/api/cart",
            json={
                "lines": [
                    {"handle": p["handle"], "size": line["size"], "qty": line["qty"]}
                    for p, line in zip(products, lines, strict=True)
                ]
            },
        )
        if res.status_code >= 400:
            raise KeelsonError(f"The store did not answer the cart: HTTP {res.status_code}.")
        quoted = res.json()
    return {
        "cart": quoted["cart"],
        "total": quoted["total"],
        "sources": {
            "product": products[0] if len(products) == 1 else products,
            "cart": quoted["cart"],
        },
    }
