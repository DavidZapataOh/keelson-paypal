"""Verifies the exports `write-exports.ts` wrote with AP2's reference SDK (v0.2.0).

Every export must pass the SDK's signature, chain and receipt checks. Then:
- an allowed purchase whose Alibi discloses its cart has no constraint violation;
- an allowed purchase whose Alibi does not disclose its cart violates only `line_items`, since
  AP2 cannot see the items;
- a refused purchase has violations, and its payment receipt says `Error`.
"""

import json
import sys
from pathlib import Path

from ap2.sdk.checkout_mandate_chain import CheckoutMandateChain
from ap2.sdk.constraints import MandateContext
from ap2.sdk.mandate import MandateClient
from ap2.sdk.payment_mandate_chain import PaymentMandateChain
from ap2.sdk.receipt_wrapper import ReceiptClient
from ap2.sdk.sdjwt.common import compute_sd_hash, parse_token
from ap2.sdk.utils import compute_sha256_b64url
from jwcrypto.jwk import JWK


NO_CART = "Empty cart does not satisfy line_items constraint"


def ap2(e: dict) -> list[str]:
    x = e["ap2"]
    issuer = JWK(**e["issuer_jwk"])
    client = MandateClient()
    nonce = e["alibi"]
    checkout = client.verify(
        x["checkout"]["closed"],
        lambda _t: issuer,
        expected_aud="merchant",
        expected_nonce=nonce,
        current_time=e["now"],
    )
    checkout_jwt = x["checkout"]["checkout_jwt"]
    violations = CheckoutMandateChain.parse(checkout).verify(
        expected_checkout_hash=compute_sha256_b64url(checkout_jwt), checkout_jwt=checkout_jwt
    )
    payment = client.verify(
        x["payment"]["closed"],
        lambda _t: issuer,
        expected_aud="paypal",
        expected_nonce=nonce,
        current_time=e["now"],
    )
    violations += PaymentMandateChain.parse(payment).verify(
        expected_transaction_id=compute_sha256_b64url(checkout_jwt),
        expected_open_checkout_hash=compute_sd_hash(parse_token(x["checkout"]["open"])),
        mandate_context=MandateContext(),
    )
    for kind in ("checkout", "payment"):
        chain = x[kind]["closed"]
        final = chain.rsplit("~~", 1)[-1]
        reference = compute_sd_hash(parse_token(final))
        # AP2 #384: the callback has no usable default, so it is always passed. AP2 #365: the key
        # is annotated as a `cryptography` EC key but used as a jwcrypto JWK.
        result = ReceiptClient().verify_receipt(
            x[kind]["receipt"],
            issuer,
            has_reference_in_store_cb=lambda r, ref=reference: r == ref,
            is_payment_receipt=kind == "payment",
        )
        if "error" in result:
            raise AssertionError(f"{kind} receipt: {result}")
    return violations


def main() -> int:
    failed = False
    for path in sorted(Path(__file__).with_name("out").glob("*.json")):
        e = json.loads(path.read_text())
        violations = ap2(e)
        status = json.loads(
            __import__("base64").urlsafe_b64decode(
                e["ap2"]["payment"]["receipt"].split(".")[1] + "=="
            )
        )["status"]
        if e["decision"] == "deny":
            ok = status == "Error" and bool(violations)
        elif e["cart_disclosed"]:
            ok = status == "Success" and not violations
        else:
            ok = status == "Success" and violations == [NO_CART]
        failed |= not ok
        print(f"{'pass' if ok else 'FAIL'}  AP2 v0.2.0 SDK  {e['alibi']} {e['decision']:5} {status:7} {violations}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
