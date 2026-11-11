"""Verifies the exports `export.ts` wrote with the AP2 v0.2.0 SDK and Verifiable Intent's
`verify_chain`, at the time each purchase was countersigned.

An ALLOW must pass every check; a DENY must pass the signature checks and fail the constraint
check that made Keelson deny it.
"""

import json
import sys
from pathlib import Path
from unittest import mock

from ap2.sdk.checkout_mandate_chain import CheckoutMandateChain
from ap2.sdk.constraints import MandateContext
from ap2.sdk.mandate import MandateClient
from ap2.sdk.payment_mandate_chain import PaymentMandateChain
from ap2.sdk.receipt_wrapper import ReceiptClient
from ap2.sdk.sdjwt.common import compute_sd_hash, parse_token
from ap2.sdk.utils import compute_sha256_b64url
from jwcrypto.jwk import JWK
from verifiable_intent.crypto.disclosure import hash_disclosure
from verifiable_intent.crypto.sd_jwt import decode_sd_jwt, resolve_disclosures
from verifiable_intent.crypto.signing import jwk_to_public_key
from verifiable_intent.verification import chain as vi_chain
from verifiable_intent.verification.constraint_checker import check_constraints

VI_L1_VCT = "https://keelson.finance/credentials/paypal/v1"


def ap2(e: dict) -> list[str]:
    x = e["ap2"]
    key = JWK(**e["keelson_jwk"])
    client = MandateClient()
    checkout = client.verify(
        x["closed"]["checkout"],
        lambda _t: key,
        expected_aud="merchant",
        expected_nonce=x["nonce"],
        current_time=e["now"],
    )
    checkout_jwt = checkout[1]["checkout_jwt"]
    violations = CheckoutMandateChain.parse(checkout).verify(
        expected_checkout_hash=compute_sha256_b64url(checkout_jwt), checkout_jwt=checkout_jwt
    )
    payment = client.verify(
        x["closed"]["payment"],
        lambda _t: key,
        expected_aud="paypal",
        expected_nonce=x["nonce"],
        current_time=e["now"],
    )
    violations += PaymentMandateChain.parse(payment).verify(
        expected_transaction_id=compute_sha256_b64url(checkout_jwt),
        expected_open_checkout_hash=compute_sd_hash(parse_token(x["open"]["checkout"])),
        mandate_context=MandateContext(),
    )
    for kind, chain in (("checkout", x["closed"]["checkout"]), ("payment", x["closed"]["payment"])):
        reference = compute_sha256_b64url(client.get_closed_mandate_jwt(chain))
        result = ReceiptClient().verify_receipt(
            x["receipts"][kind],
            key,
            has_reference_in_store_cb=lambda r, ref=reference: r == ref,
            is_payment_receipt=kind == "payment",
        )
        if "error" in result:
            raise AssertionError(f"AP2 {kind} receipt: {result['error']}")
    return violations


def vi(e: dict) -> list[str]:
    x = e["vi"]
    issuer = jwk_to_public_key(e["keelson_jwk"])
    l1, l2 = decode_sd_jwt(x["l1"]), decode_sd_jwt(x["l2"])
    with mock.patch.object(vi_chain.time, "time", return_value=e["now"]):
        network = vi_chain.verify_chain(
            l1,
            l2,
            l3_payment=decode_sd_jwt(x["l3Payment"]),
            issuer_public_key=issuer,
            l1_serialized=x["l1"],
            l2_serialized=x["l2"],
            l2_payment_serialized=x["l2Payment"],
            expected_l1_vct=VI_L1_VCT,
            expected_l3_payment_aud=x["network_aud"],
            expected_l3_payment_nonce=x["nonce"],
        )
        merchant = vi_chain.verify_chain(
            l1,
            l2,
            l3_checkout=decode_sd_jwt(x["l3Checkout"]),
            issuer_public_key=issuer,
            l1_serialized=x["l1"],
            l2_serialized=x["l2"],
            l2_checkout_serialized=x["l2Checkout"],
            expected_l1_vct=VI_L1_VCT,
            expected_l3_checkout_aud=x["merchant_aud"],
            expected_l3_checkout_nonce=x["nonce"],
        )
    for side, result in (("network", network), ("merchant", merchant)):
        if not result.valid:
            raise AssertionError(f"VI {side} chain: {result.errors}")
    by_hash = {hash_disclosure(d): v for d, v in zip(l2.disclosures, l2.disclosure_values)}
    claims = resolve_disclosures(l2)
    payment = next(d for d in claims["delegate_payload"] if d.get("vct") == "mandate.payment.open.1")
    fulfillment = next(
        d for d in network.l3_payment_claims["delegate_payload"] if d.get("vct") == "mandate.payment.1"
    )
    for c in payment["constraints"]:
        if c["type"] == "mandate.payment.allowed_payees":
            fulfillment["allowed_merchants"] = [by_hash[r["..."]][-1] for r in c["allowed"]]
    return check_constraints(payment["constraints"], fulfillment).violations


def main() -> int:
    exports = json.loads(Path(__file__).with_name("exports.json").read_text())
    failed = False
    for e in exports:
        for name, check in (("AP2 v0.2.0", ap2), ("Verifiable Intent", vi)):
            violations = check(e)
            ok = not violations if e["decision"] == "allow" else bool(violations)
            failed |= not ok
            verdict = "pass" if ok else "FAIL"
            print(f"{verdict}  {name:18} {e['alibi']} {e['decision']:5} {violations}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
