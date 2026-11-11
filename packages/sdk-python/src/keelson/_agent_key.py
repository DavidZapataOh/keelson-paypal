from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any

from ._errors import KeelsonError
from ._jcs import canonicalize


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def cart_hash(cart: dict[str, Any]) -> str:
    """``sha256:<hex>`` of ``"keelson/cart/v1" ‖ 0x00 ‖ JCS(cart)``, absent size or color as null."""
    body = canonicalize(
        {
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
    )
    return "sha256:" + hashlib.sha256(b"keelson/cart/v1\x00" + body.encode()).hexdigest()


def import_agent_key(jwk: dict[str, Any] | str) -> Any:
    """The agent's P-256 ``cnf`` key from its private JWK (``KEELSON_AGENT_KEY``).

    Needs ``pip install keelson-finance[operator]``.
    """
    try:
        from cryptography.hazmat.primitives.asymmetric import ec
    except ImportError as err:  # pragma: no cover - depends on the extra
        raise KeelsonError("Closing a mandate needs: pip install keelson-finance[operator]") from err
    key = json.loads(jwk) if isinstance(jwk, str) else jwk
    if key.get("kty") != "EC" or key.get("crv") != "P-256" or not all(k in key for k in "dxy"):
        raise KeelsonError("The agent key is not a private P-256 JWK.")

    def num(s: str) -> int:
        return int.from_bytes(base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)), "big")

    public = ec.EllipticCurvePublicNumbers(num(key["x"]), num(key["y"]), ec.SECP256R1())
    return ec.EllipticCurvePrivateNumbers(num(key["d"]), public).private_key()


def close_mandate(open_mandate: str, *, request_id: str, cart: dict[str, Any], key: Any, iat: int | None = None) -> str:
    """Appends a KB-JWT signed by the agent's key binding the request and the cart (RFC 9901 §4.3)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    tail = open_mandate[open_mandate.find("~~") + 2 :]
    if not open_mandate.endswith("~") or "~~" not in open_mandate or not tail:
        raise KeelsonError("Not an open mandate.")
    header = _b64url(json.dumps({"typ": "kb+jwt", "alg": "ES256"}, separators=(",", ":")).encode())
    payload = _b64url(
        json.dumps(
            {
                "iat": iat if iat is not None else int(time.time()),
                "aud": "keelson.finance/countersign",
                "nonce": request_id,
                "sd_hash": _b64url(hashlib.sha256(tail.encode()).digest()),
                "cart_hash": cart_hash(cart),
            },
            separators=(",", ":"),
        ).encode()
    )
    der = key.sign(f"{header}.{payload}".encode(), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return f"{open_mandate}{header}.{payload}.{_b64url(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
