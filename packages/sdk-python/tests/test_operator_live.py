import os
import re
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from keelson import ClientCredentials, KeelsonAgent, create_client, unwrap
from keelson.generated.api.purchases import get_purchase

# As an operator's agent on Keelson's sandbox, with its OAuth client and `cnf` key:
#   KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET, KEELSON_AGENT_ID, KEELSON_AGENT_KEY
# The purchase needs a mandate the user signed for that operator and whose PayPal hold they
# approved, with $129 left on it.
NEEDED = ("KEELSON_CLIENT_ID", "KEELSON_CLIENT_SECRET", "KEELSON_AGENT_ID", "KEELSON_AGENT_KEY")
pytestmark = pytest.mark.skipif(
    not all(os.environ.get(n) for n in NEEDED), reason="needs an operator's credentials"
)
EXAMPLES = Path(__file__).resolve().parents[1] / "examples"


def agent() -> KeelsonAgent:
    client = create_client(
        ClientCredentials(
            os.environ["KEELSON_CLIENT_ID"],
            os.environ["KEELSON_CLIENT_SECRET"],
            ["countersign:write", "evidence:write"],
        )
    )
    return KeelsonAgent(client, agent_id=os.environ["KEELSON_AGENT_ID"])


def test_asks_the_user_for_a_mandate() -> None:
    asked = agent().request_mandate(
        name="Keelson SDK test",
        reason="The SDK's own test asks for this mandate to check that a request reaches you; decline it, or let it expire in fifteen minutes.",
        per_purchase_minor=1_000,
        total_minor=1_000,
        until=(datetime.now(UTC) + timedelta(hours=1)).isoformat(),
    )
    assert asked["status"] == "pending_approval"
    assert asked["next"]["action"] == "show_user_then_poll"
    assert asked["approvalUrl"].startswith("https://app.keelson.finance/connect/?c=")  # type: ignore[typeddict-item]
    assert str(asked["matchNumber"]) in asked["next"]["say"]  # type: ignore[typeddict-item]


def test_the_countersign_example_completes_a_purchase_and_its_alibi_verifies() -> None:
    run = subprocess.run(
        [sys.executable, str(EXAMPLES / "countersign.py")],
        capture_output=True,
        text=True,
        timeout=300,
        check=True,
    )
    found = re.search(r"^success Purchase (\w{26}) (is|was) captured", run.stdout, re.M)
    assert found, run.stdout + run.stderr
    purchase = unwrap(get_purchase.sync_detailed(id=found[1], client=agent().client))
    assert purchase.capture
    verified = subprocess.run(
        [sys.executable, str(EXAMPLES / "verify_alibi.py"), found[1]],
        capture_output=True,
        text=True,
        timeout=300,
        check=True,
    )
    assert verified.stdout.strip().splitlines()[-1] == "verified-offline"
