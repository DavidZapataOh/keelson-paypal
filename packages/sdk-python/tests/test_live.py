import base64
import hashlib
import json
import os
import uuid
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from keelson import (
    ClientCredentials,
    KeelsonAgent,
    KeelsonError,
    OAuthError,
    cart_hash,
    close_mandate,
    create_authorization_request,
    create_client,
    fetch_alibi,
    register_public_client,
    unwrap,
    verify_alibi,
)
from keelson.generated.api.alibis import get_alibi_receipt
from keelson.generated.api.purchases import get_purchase, list_live_purchases
from keelson.generated.api.system import get_health

# The generated client against Keelson's API on the PayPal sandbox, with no credentials.
pytestmark = pytest.mark.skipif(
    os.environ.get("KEELSON_LIVE") != "1", reason="set KEELSON_LIVE=1 to run against the sandbox"
)

client = create_client()


def logged_purchase() -> str:
    purchases = unwrap(list_live_purchases.sync_detailed(client=client)).purchases
    return next(p.id for p in purchases if p.log_index is not None)


def test_reads_typed_answers() -> None:
    assert unwrap(get_health.sync_detailed(client=client)).status == "ok"
    receipt = unwrap(get_alibi_receipt.sync_detailed(id=logged_purchase(), client=client))
    assert len(receipt.leaf_hash) == 43


def test_an_answer_that_is_not_2xx_is_a_typed_problem() -> None:
    with pytest.raises(KeelsonError) as missing:
        unwrap(get_alibi_receipt.sync_detailed(id="01J00000000000000000000000", client=client))
    assert missing.value.status == 404
    with pytest.raises(KeelsonError) as anonymous:
        unwrap(get_purchase.sync_detailed(id="01J00000000000000000000000", client=client))
    assert anonymous.value.status == 401 and anonymous.value.type == "unauthorized"


def test_the_async_client_reads_the_same() -> None:
    import asyncio

    answer = asyncio.run(get_health.asyncio_detailed(client=client))
    assert unwrap(answer).status == "ok"


def test_a_write_without_a_token_answers_an_error_envelope() -> None:
    answer = KeelsonAgent(client).request_mandate(
        name="SDK test",
        reason="x" * 120,
        per_purchase_minor=1000,
        total_minor=2000,
        until=(datetime.now(UTC) + timedelta(hours=1)).isoformat(),
    )
    assert answer["status"] == "error"
    assert answer["retryable"] is False
    assert answer["next"]["action"] == "tell_user"
    assert "401" in answer["message"]


def test_keelson_replays_a_post_sent_again_with_the_same_key() -> None:
    bundle = fetch_alibi(client, logged_purchase())
    key = str(uuid.uuid4())
    http = client.get_httpx_client()
    headers = {"content-type": "application/vnd.keelson.alibi.v1+json", "idempotency-key": key}
    first = http.post("/v1/alibis/verify", content=bundle, headers=headers)
    second = http.post("/v1/alibis/verify", content=bundle, headers=headers)
    assert first.status_code == 200
    assert second.headers["idempotent-replayed"] == "true"
    assert second.json() == first.json()


def test_a_live_alibi_verifies_offline() -> None:
    report = verify_alibi(fetch_alibi(client, logged_purchase()))
    assert report["verdict"] == "verified-offline"
    assert [c for c in report["checks"] if c["status"] == "fail"] == []
    statuses = {c["id"]: c["status"] for c in report["checks"]}
    assert statuses["tee.countersign"] == "pass"
    assert statuses["mandate.passkey"] == "pass"
    assert statuses["log.inclusion"] == "pass"


def test_with_the_chain_read_the_anchor_verifies_too() -> None:
    assert verify_alibi(fetch_alibi(client, logged_purchase()), chain=True)["verdict"] == "verified"


def test_one_changed_field_fails_it() -> None:
    bundle = json.loads(fetch_alibi(client, logged_purchase()))
    bundle["eval"]["decision"] = "deny" if bundle["eval"]["decision"] == "allow" else "allow"
    assert verify_alibi(bundle)["verdict"] == "failed"


def test_client_credentials_with_a_wrong_secret_is_an_oauth_error() -> None:
    with pytest.raises(OAuthError) as err:
        ClientCredentials("not-a-client", "wrong", ["countersign:write"]).token()
    assert err.value.error == "invalid_client"


def test_an_app_registers_and_starts_the_pkce_flow() -> None:
    redirect_uri = "http://127.0.0.1:8976/callback"
    client_id = register_public_client("Keelson SDK test", [redirect_uri])
    request = create_authorization_request(client_id, redirect_uri)
    query = httpx2.URL(request.url).params
    assert query["code_challenge_method"] == "S256"
    assert query["resource"] == "https://api.keelson.finance"
    # The authorization server accepts the request and sends the user to sign in.
    answer = httpx2.get(request.url)
    assert answer.status_code in (200, 302)
    sign_in = httpx2.URL(
        answer.headers["location"] if answer.status_code == 302 else answer.json()["url"]
    )
    assert sign_in.host == "app.keelson.finance"
    assert "error" not in sign_in.params
    assert sign_in.params["code_challenge"] == query["code_challenge"]


def test_close_mandate_binds_a_live_open_mandate_to_the_request_and_cart() -> None:
    bundle = json.loads(fetch_alibi(client, logged_purchase()))
    open_mandate = bundle["mandate"]["sd_jwt"]
    key = ec.generate_private_key(ec.SECP256R1())
    cart = bundle["cart"]
    closed = close_mandate(open_mandate, "01J00000000000000000000000", cart_hash(cart), key)
    assert closed.startswith(open_mandate)
    kb = closed[len(open_mandate) :]
    header_b64, payload_b64, sig_b64 = kb.split(".")

    def decode(part: str) -> bytes:
        return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))

    assert json.loads(decode(header_b64)) == {"typ": "kb+jwt", "alg": "ES256"}
    payload = json.loads(decode(payload_b64))
    final = open_mandate[open_mandate.index("~~") + 2 :]
    assert (
        payload["sd_hash"]
        == base64.urlsafe_b64encode(hashlib.sha256(final.encode()).digest()).rstrip(b"=").decode()
    )
    assert payload["nonce"] == "01J00000000000000000000000"
    assert payload["aud"] == "keelson.finance/countersign"
    assert payload["cart_hash"] == cart_hash(cart)
    sig = decode(sig_b64)
    der = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
    key.public_key().verify(der, f"{header_b64}.{payload_b64}".encode(), ec.ECDSA(hashes.SHA256()))
