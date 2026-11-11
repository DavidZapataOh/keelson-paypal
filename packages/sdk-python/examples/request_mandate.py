"""Asks the user for a mandate as the operator's agent and waits for their answer.

KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET   the agent's OAuth client

python examples/request_mandate.py
"""

import os
from datetime import UTC, datetime, timedelta

from keelson import ClientCredentials, KeelsonAgent, create_client

client = create_client(
    ClientCredentials(
        os.environ["KEELSON_CLIENT_ID"],
        os.environ["KEELSON_CLIENT_SECRET"],
        ["countersign:write", "evidence:write"],
    )
)
agent = KeelsonAgent(client)

asked = agent.request_mandate(
    name="Running shoes agent",
    reason="I will buy one pair of running shoes in your size from RunFast, comparing the models in stock and staying under the price you set.",
    per_purchase_minor=15_000,
    total_minor=15_000,
    until=(datetime.now(UTC) + timedelta(days=1)).isoformat(),
)
# Show the user the link and the number together; they pick the number on Keelson's page.
print(asked["next"]["say"])
answer = agent.settle(asked)
print(answer["status"], answer["message"])
