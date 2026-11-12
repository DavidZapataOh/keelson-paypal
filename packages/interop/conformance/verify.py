"""Verifies the exports `write-exports.ts` wrote with the standards' reference verifiers: AP2's
SDK (v0.2.0) and Verifiable Intent's reference implementation (v0.1).

Every export must pass the signature, chain and receipt checks. Then:
- an allowed purchase whose Alibi discloses its cart has no constraint violation;
- an allowed purchase whose Alibi does not disclose its cart violates only `line_items`, since
  the verifier cannot see the items;
- a refused purchase closes no payment mandate, has violations, and its AP2 checkout receipt says
  `Error`.
"""

import base64
import copy
import json
import sys
from pathlib import Path
from unittest.mock import patch

from ap2.sdk.checkout_mandate_chain import CheckoutMandateChain
from ap2.sdk.constraints import MandateContext
from ap2.sdk.mandate import MandateClient
from ap2.sdk.payment_mandate_chain import PaymentMandateChain
from ap2.sdk.receipt_wrapper import ReceiptClient
from ap2.sdk.sdjwt.common import compute_sd_hash, parse_token
from ap2.sdk.utils import compute_sha256_b64url
from jwcrypto.jwk import JWK
from verifiable_intent.crypto.disclosure import hash_disclosure
from verifiable_intent.crypto.sd_jwt import SdJwt, decode_sd_jwt
from verifiable_intent.crypto.signing import jwk_to_public_key
from verifiable_intent.verification import chain
from verifiable_intent.verification.chain import verify_chain
from verifiable_intent.verification.constraint_checker import StrictnessMode, check_constraints


NO_CART = "Empty cart does not satisfy line_items constraint"
VI_NO_CART = "Empty line_items does not satisfy line_items constraint with required items"
VI_L1_VCT = "https://keelson.finance/credentials/paypal/v1"


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
    # A refused purchase closes no payment mandate.
    if e["decision"] == "deny" and "closed" in x["payment"]:
        raise AssertionError("a refused purchase carries a closed payment mandate")
    kinds = ("checkout", "payment") if "closed" in x["payment"] else ("checkout",)
    if "closed" not in x["payment"]:
        return violations + _receipts(x, issuer, kinds)
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
    return violations + _receipts(x, issuer, kinds)


def _receipts(x: dict, issuer: JWK, kinds: tuple[str, ...]) -> list[str]:
    for kind in kinds:
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
    return []


def _jwt_payload(jwt: str) -> dict:
    return json.loads(base64.urlsafe_b64decode(jwt.split(".")[1] + "=="))


def _mandate(claims: dict, vct: str) -> dict:
    return next(d for d in claims["delegate_payload"] if isinstance(d, dict) and d.get("vct") == vct)


def _resolve(l2: SdJwt, refs: list) -> list:
    """The values a presentation discloses for `{"...": digest}` references."""
    by_digest = {hash_disclosure(d): v[-1] for d, v in zip(l2.disclosures, l2.disclosure_values)}
    return [by_digest[r["..."]] for r in refs if isinstance(r, dict) and r.get("...") in by_digest]


def vi(e: dict) -> list[str]:
    x = e["vi"]
    issuer = jwk_to_public_key(e["issuer_jwk"])
    l1 = decode_sd_jwt(x["l1"])
    results = {}
    # The reference reads the wall clock; the exports are checked at the time they were made.
    with patch.object(chain.time, "time", return_value=e["now"]):
        views = [("checkout", "l3_checkout", "expected_l3_checkout")]
        if x.get("l3_payment"):
            views.insert(0, ("payment", "l3_payment", "expected_l3_payment"))
        elif e["decision"] == "allow":
            raise AssertionError("an allowed purchase lacks its L3 payment mandate")
        for view, l3, expected in views:
            l2 = decode_sd_jwt(x[f"l2_{view}"])
            result = verify_chain(
                l1,
                l2,
                issuer_public_key=issuer,
                l1_serialized=x["l1"],
                l2_serialized=x[f"l2_{view}"],
                expected_l1_vct=VI_L1_VCT,
                **{
                    l3: decode_sd_jwt(x[l3]),
                    f"l2_{view}_serialized": x[f"l2_{view}"],
                    f"{expected}_aud": x["network_aud" if view == "payment" else "merchant_aud"],
                    f"{expected}_nonce": x["nonce"],
                },
            )
            if not result.valid:
                raise AssertionError(f"VI {view} chain: {result.errors}")
            results[view] = (l2, result)

    violations = []
    if "payment" in results:
        l2, network = results["payment"]
        constraints = _mandate(network.l2_claims, "mandate.payment.open.1")["constraints"]
        fulfillment = dict(_mandate(network.l3_payment_claims, "mandate.payment.1"))
        for c in constraints:
            if c["type"] == "mandate.payment.allowed_payees":
                fulfillment["allowed_merchants"] = _resolve(l2, c["allowed"])
        violations = check_constraints(constraints, fulfillment, mode=StrictnessMode.STRICT).violations

    l2, merchant = results["checkout"]
    constraints = copy.deepcopy(_mandate(merchant.l2_claims, "mandate.checkout.open.1")["constraints"])
    checkout = _jwt_payload(_mandate(merchant.l3_checkout_claims, "mandate.checkout.1")["checkout_jwt"])
    fulfillment = {
        "merchant": checkout["merchant"],
        "line_items": [{"id": li["item"]["id"], "quantity": li["quantity"]} for li in checkout["line_items"]],
    }
    for c in constraints:
        if c["type"] == "mandate.checkout.allowed_merchants":
            fulfillment["allowed_merchants"] = _resolve(l2, c["allowed"])
        elif c["type"] == "mandate.checkout.line_items":
            for item in c["items"]:
                item["acceptable_items"] = _resolve(l2, item["acceptable_items"])
    return violations + check_constraints(constraints, fulfillment, mode=StrictnessMode.STRICT).violations


def main() -> int:
    failed = False
    for path in sorted(Path(__file__).with_name("out").glob("*[0-9A-Z].json")):
        e = json.loads(path.read_text())
        violations = ap2(e)
        status = json.loads(
            __import__("base64").urlsafe_b64decode(
                e["ap2"]["checkout"]["receipt"].split(".")[1] + "=="
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

        violations = vi(e)
        if e["decision"] == "deny":
            ok = bool(violations)
        elif e["cart_disclosed"]:
            ok = not violations
        else:
            ok = violations == [VI_NO_CART]
        failed |= not ok
        print(f"{'pass' if ok else 'FAIL'}  Verifiable Intent  {e['alibi']} {e['decision']:5} {violations}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
