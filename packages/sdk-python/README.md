# keelson-finance

Keelson for Python (`import keelson`). Your agent asks the user for a mandate, the user signs it
with a passkey, and every purchase is checked by two TEEs before PayPal captures it. Each purchase
comes with an Alibi you can verify offline.

Runs on the PayPal sandbox and Arbitrum Sepolia: no real money moves. Python 3.11 or later.

## Install

```sh
pip install keelson-finance
keelson login
```

From this repository, before the package is on PyPI: `uv run --project packages/sdk-python keelson login`.

`keelson login` signs you in in your browser and saves the sign-in to
`~/.config/keelson/credentials.json`, the same file the TypeScript SDK uses.

## Quickstart

```python
from keelson import Keelson, quote, verify_alibi

keelson = Keelson()  # signed in with `keelson login`
why = "I buy one pair of Pace Lite running shoes, size 10, at RunFast on the PayPal sandbox, and nothing else."
req = keelson.mandates.request(name="Quickstart", reason=why, per_purchase="$100", total="$100", until="1h")
print(f"Approve with your passkey: {req.approval_url}")
mandate = keelson.mandates.wait_for_approval(req.id)
q = quote([{"productUrl": "https://store.keelson.finance/products/pace-lite", "size": "10", "qty": 1}])
seen = {**q["sources"], "observation": "Pace Lite, size 10, $99.00."}
sealed = keelson.evidence.seal(mandate_id=mandate.id, sources=seen)
signed = keelson.purchases.countersign(mandate=mandate, evidence_root=sealed["evidenceRoot"], cart=q["cart"])
report = verify_alibi(keelson.alibis.retrieve(keelson.purchases.wait_for(signed.purchase_id).id))
print(f"Bought {signed.purchase_id}. Alibi: {report['verdict']}")  # verified-offline
```

`AsyncKeelson` is the same client for asyncio: every method is awaited.

## Methods, errors and retries

The same as the TypeScript SDK, in snake_case: `mandates.request`, `mandates.wait_for_approval`,
`mandates.request_change`, `mandates.list`, `mandates.check`, `requests.retrieve`,
`evidence.seal`, `purchases.countersign`, `purchases.wait_for`, `purchases.retrieve`,
`alibis.retrieve`, `alibis.receipt`, `alibis.pdf`, `alibis.verify_remote`, `events.stream`,
`operators.link`, `operators.grade`, `operators.announce_run`. Every POST carries an
`Idempotency-Key` kept across retries. A lost countersign raises `OutcomeUnknownError`: never send
it again, call `purchases.wait_for(err.request_id)`.

An operator closing mandates with its own key installs `keelson-finance[operator]` and sets
`KEELSON_CLIENT_ID`, `KEELSON_CLIENT_SECRET` and `KEELSON_AGENT_KEY`.

## Agent frameworks

```python
from keelson.adapters.openai_agents import openai_agents_tools  # pip install keelson-finance[openai-agents]
from keelson.adapters.langchain import langchain_tools  # pip install keelson-finance[langchain]
from keelson.adapters.claude_agent_sdk import keelson_mcp_server  # pip install keelson-finance[claude-agent-sdk]
```

## Verifying an Alibi

`verify_alibi(bytes)` runs the same verifier as https://verify.keelson.finance through
`keelson-verify` (Node.js 20 or later), so Python and TypeScript give the same verdict for the
same bytes.

## License

Apache-2.0
