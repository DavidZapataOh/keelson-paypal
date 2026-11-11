# keelson-sdk

Python SDK for Keelson's API: ask a user for a spending mandate, get each cart countersigned before PayPal captures it, and verify the purchase's Alibi on your own machine.

The client is generated from Keelson's OpenAPI document (`openapi/keelson.yaml`) with openapi-python-client: one module per operation under `keelson.generated.api`, each with `sync`, `sync_detailed`, `asyncio` and `asyncio_detailed`, and typed attrs models under `keelson.generated.models`. On top of it the SDK adds OAuth, retries with idempotency keys, the agent flow with the same answers as Keelson's MCP tools, and offline Alibi verification.

Keelson's API at `https://api.keelson.finance` runs on the **PayPal sandbox** and anchors on **Arbitrum Sepolia**: no real money moves.

```sh
pip install keelson-sdk
```

Python 3.11 or later.

## The client

```python
import os

from keelson import ClientCredentials, create_client, unwrap
from keelson.generated.api.purchases import get_purchase

client = create_client(
    ClientCredentials(
        os.environ["KEELSON_CLIENT_ID"],
        os.environ["KEELSON_CLIENT_SECRET"],
        ["countersign:write", "evidence:write"],
    )
)

# The parsed answer, with any RFC 9457 problem raised as KeelsonError (status, type, problem).
purchase = unwrap(get_purchase.sync_detailed(id=purchase_id, client=client))

# The same with asyncio.
purchase = unwrap(await get_purchase.asyncio_detailed(id=purchase_id, client=client))
```

Every call, sync or async:

- sends the bearer token, and gets one fresh token if the API answers `401 invalid_token`;
- gives each POST an `Idempotency-Key`, the same across its retries, so Keelson runs it at most once;
- retries network failures, `408`, `425`, `429`, `5xx` and a `409 idempotency-in-progress`, up to three times with exponential backoff and full jitter, honoring `Retry-After` (`create_client(retry=Retry(max_retries=…, base_delay=…, max_delay=…))`).

Public operations (`get_health`, `list_live_purchases`, `get_alibi_receipt`, `get_trust_grade`, …) work with `create_client()` and no credentials.

## Authentication

| Who                      | Grant                                        | Helper                                                                                 |
| ------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| An operator's own agent  | Client credentials (RFC 6749 §4.4)            | `ClientCredentials(client_id, client_secret, scopes)`                                  |
| An app acting for a user | Authorization code with PKCE S256 (RFC 7636)  | `register_public_client`, `create_authorization_request`, `exchange_code`, `UserTokens` |
| A token you already have |                                              | `StaticToken(token)`                                                                   |

```python
from keelson import (
    UserTokens,
    create_authorization_request,
    create_client,
    exchange_code,
    register_public_client,
)

redirect_uri = "http://127.0.0.1:8976/callback"
client_id = register_public_client("My shopping app", [redirect_uri])
request = create_authorization_request(client_id, redirect_uri)
# Open request.url for the user; Keelson redirects to redirect_uri?code=…&state=…; check state.
tokens = exchange_code(client_id, code, request.code_verifier, redirect_uri)
client = create_client(UserTokens(client_id, tokens, on_tokens=save))
```

Every token is requested for the resource `https://api.keelson.finance` (RFC 8707). When the user stops every agent, the refresh token is revoked and the next call raises `OAuthError` `invalid_grant`: ask the user to sign in again.

## The agent flow

`KeelsonAgent` runs the same steps as Keelson's MCP tools and answers with the same envelope, a dict:

```python
{"status": ..., "next": {"action": ..., "tool": ..., "arguments": ..., "afterSeconds": ..., "say": ...}, "message": ..., **fields}
```

`status` is `pending_approval`, `approved`, `denied`, `blocked`, `success` or `error` (with `retryable`). `next["tool"]` names the MCP tool; its method here is the name without `keelson.` (`keelson.get_request` → `get_request`). A write is never called again to finish what it started: `get_request` and `get_purchase` are the polls, and `settle(envelope)` follows them. A purchase with `outcome == "unknown"` may have moved money: poll it, never start it again.

### Request a mandate

[`examples/request_mandate.py`](examples/request_mandate.py)

```python
agent = KeelsonAgent(client)
asked = agent.request_mandate(
    name="Running shoes agent",
    reason="I will buy one pair of running shoes in your size from RunFast, comparing the models in stock and staying under the price you set.",
    per_purchase_minor=15_000,
    total_minor=15_000,
    until=(datetime.now(UTC) + timedelta(days=1)).isoformat(),
)
print(asked["next"]["say"])  # the link and the two-digit number to show the user
answer = agent.settle(asked)
```

### Countersign

[`examples/countersign.py`](examples/countersign.py) buys from Keelson's demo store under a held mandate:

```python
agent = KeelsonAgent(
    client,
    agent_id=os.environ["KEELSON_AGENT_ID"],
    agent_key=import_agent_key(os.environ["KEELSON_AGENT_KEY"]),  # the P-256 key the mandate names
)
sealed = agent.submit_evidence(mandate_id, product=product, cart=cart, observation=observation)
check = agent.check_cart(mandate_id, cart)  # a dry run, nothing signed
sent = agent.request_countersign(mandate_id, evidence_root=sealed["evidenceRoot"], cart=cart)
done = agent.settle(sent)  # success once PayPal captured it
```

The evidence manifest, the cart hash and the closed mandate's key binding JWT are computed byte for byte as Keelson computes them (`build_manifest`, `cart_hash`, `close_mandate`).

## Verify an Alibi offline

[`examples/verify_alibi.py`](examples/verify_alibi.py)

```python
from keelson import create_client, fetch_alibi, verify_alibi

report = verify_alibi(fetch_alibi(create_client(), purchase_id))
report["verdict"]  # "verified-offline"
verify_alibi(alibi, chain=True)["verdict"]  # also reads the anchor: "verified"
```

The checks are not reimplemented in Python: `verify_alibi` runs Keelson's reference verifier, the `keelson-verify` command of `@keelson/sdk`, the same code as the browser verifier at verify.keelson.finance, on this machine. It needs Node.js 22 or later (`npx`); without it, `VerifierUnavailable` is raised. Keelson's servers are asked nothing. `KEELSON_VERIFY_COMMAND` runs another build, e.g. `node packages/sdk/dist/cli.js`.

## Development

```sh
uv run --group generate python scripts/generate.py   # regenerate src/keelson/generated
uv run --group dev pytest                             # offline tests
KEELSON_LIVE=1 uv run --group dev pytest              # plus the public API on the sandbox
uv run --group dev ruff check . && uv run --group dev mypy
```

`scripts/generate.py` documents how it adapts the OpenAPI document for the generator without changing what it describes. `tests/vectors.json` holds values computed by Keelson's TypeScript packages, which the Python evidence code must match. `tests/test_operator_live.py` runs as an operator when `KEELSON_CLIENT_ID`, `KEELSON_CLIENT_SECRET`, `KEELSON_AGENT_ID` and `KEELSON_AGENT_KEY` are set.
