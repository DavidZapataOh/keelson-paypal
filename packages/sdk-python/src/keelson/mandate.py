"""Closing an open mandate with the agent's key (draft-ietf-oauth-delegate-sd-jwt, RFC 9901)."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import time
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

CLOSED_MANDATE_TYP = "kb+jwt"
CLOSED_MANDATE_AUD = "keelson.finance/countersign"
_ULID = re.compile(r"^[0-7][0-9A-HJKMNP-TV-Z]{25}$")
_CART_HASH = re.compile(r"^sha256:[0-9a-f]{64}$")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def import_agent_key(private_jwk: str | dict[str, Any]) -> ec.EllipticCurvePrivateKey:
    """The agent's P-256 ``cnf`` key from its private JWK, the key its mandates name."""
    jwk = json.loads(private_jwk) if isinstance(private_jwk, str) else private_jwk
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256" or "d" not in jwk:
        raise ValueError("the agent key is not a private P-256 JWK")
    return ec.derive_private_key(int.from_bytes(_b64url_decode(jwk["d"]), "big"), ec.SECP256R1())


def close_mandate(
    open_mandate: str,
    request_id: str,
    cart_hash: str,
    agent_key: ec.EllipticCurvePrivateKey,
    *,
    iat: int | None = None,
) -> str:
    """Appends the agent's ES256 key binding JWT, bound to the request ULID as ``nonce`` and to the
    cart as ``cart_hash``, which makes the open mandate a closed one for this countersign."""
    if not open_mandate.endswith("~") or "~~" not in open_mandate or open_mandate.endswith("~~"):
        raise ValueError("not an open mandate")
    if not _ULID.match(request_id):
        raise ValueError("request_id is not a ULID")
    if not _CART_HASH.match(cart_hash):
        raise ValueError("cart_hash is not sha256:<hex>")
    # The KB-JWT's sd_hash covers the final KB-SD-JWT and its disclosures.
    final = open_mandate[open_mandate.index("~~") + 2 :]
    payload_sd = json.loads(_b64url_decode(final.split("~", 1)[0].split(".")[1]))
    if payload_sd.get("_sd_alg", "sha-256") != "sha-256":
        raise ValueError(f"unsupported _sd_alg {payload_sd['_sd_alg']}")
    header = {"typ": CLOSED_MANDATE_TYP, "alg": "ES256"}
    payload = {
        "iat": int(time.time()) if iat is None else iat,
        "aud": CLOSED_MANDATE_AUD,
        "nonce": request_id,
        "sd_hash": _b64url(hashlib.sha256(final.encode()).digest()),
        "cart_hash": cart_hash,
    }
    signing_input = ".".join(
        _b64url(json.dumps(part, separators=(",", ":")).encode()) for part in (header, payload)
    )
    r, s = decode_dss_signature(agent_key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256())))
    signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"{open_mandate}{signing_input}.{_b64url(signature)}"
