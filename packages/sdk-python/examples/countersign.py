"""Buys one item from Keelson's demo store under a mandate the user signed and held, as the
operator's agent: seals the evidence, checks the cart, gets it countersigned and waits until
PayPal captured it on the sandbox.

    KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET   the agent's OAuth client
    KEELSON_AGENT_ID                           the operator's ERC-8004 agent id
    KEELSON_AGENT_KEY                          the private P-256 JWK the mandates name

    python examples/countersign.py
"""

import os

import httpx2

from keelson import ClientCredentials, KeelsonAgent, create_client, import_agent_key

STORE = "https://store.keelson.finance"

client = create_client(
    ClientCredentials(
        os.environ["KEELSON_CLIENT_ID"],
        os.environ["KEELSON_CLIENT_SECRET"],
        ["countersign:write", "evidence:write"],
    )
)
agent = KeelsonAgent(
    client,
    agent_id=os.environ["KEELSON_AGENT_ID"],
    agent_key=import_agent_key(os.environ["KEELSON_AGENT_KEY"]),
)

# The store prices the cart; the agent only picks the product, the size and the quantity.
product = httpx2.get(f"{STORE}/api/products/tempo-3").json()
cart = httpx2.post(
    f"{STORE}/api/cart", json={"lines": [{"handle": "tempo-3", "size": "9", "qty": 1}]}
).json()["cart"]

held = agent.confirm_mandate()
if held["status"] != "success":
    raise SystemExit(held["next"]["say"])
mandate_id = held["mandate"]["id"]  # type: ignore[typeddict-item]

sealed = agent.submit_evidence(
    mandate_id,
    product=product,
    cart=cart,
    observation="Tempo 3, size 9, blue, $129.00, in stock, 30-day free returns.",
)
if sealed["status"] != "success":
    raise SystemExit(sealed["message"])

check = agent.check_cart(mandate_id, cart)
if check["status"] != "success":
    raise SystemExit(check["next"]["say"])

# Countersign once; from here on the purchase is polled, never sent again.
sent = agent.request_countersign(mandate_id, evidence_root=sealed["evidenceRoot"], cart=cart)  # type: ignore[typeddict-item]
done = agent.settle(sent)
print(done["status"], done["message"])
