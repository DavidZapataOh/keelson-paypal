from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

import keelson
from keelson import AsyncKeelson, login, quote, stored_login

from .conftest import VERIFY_CLI, act, live, needs_buyer

pytestmark = [pytest.mark.live, live, needs_buyer]

SHOE = "https://store.keelson.finance/products/pace-lite"
REASON = (
    "I am the Python SDK's live test. I buy one pair of Pace Lite running shoes, size 10, "
    "at RunFast on the PayPal sandbox, and nothing else."
)
EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "quickstart.py"


async def test_buys_a_sandbox_pair_and_verifies_it(tmp_path: Path) -> None:
    path = tmp_path / "credentials.json"
    await login(path=path, open=lambda url: act("login", url, judge="purchase"))
    client = AsyncKeelson(stored_login(path))
    req = await client.mandates.request(
        name="Python live test", reason=REASON, per_purchase="$100", total="$100", until="1h"
    )
    act("hold", req.approval_url, judge="purchase")
    mandate = await client.mandates.wait_for_approval(req.id, timeout=120)
    q = quote([{"productUrl": SHOE, "size": "10", "qty": 1}])
    assert (await client.mandates.check(mandate.id, q["cart"])).canAttempt
    sealed = await client.evidence.seal(
        mandate_id=mandate.id, sources={**q["sources"], "observation": "Pace Lite, size 10, $99.00."}
    )
    signed = await client.purchases.countersign(mandate=mandate, evidence_root=sealed["evidenceRoot"], cart=q["cart"])
    assert signed.decision == "allow"
    purchase = await client.purchases.wait_for(signed.purchase_id)
    assert purchase.state == "CAPTURED", purchase.failure
    os.environ.setdefault("KEELSON_VERIFY_COMMAND", f"node {VERIFY_CLI}")
    report = keelson.verify_alibi(await client.alibis.retrieve(purchase.id))
    assert report["verdict"] in ("verified-offline", "verified-unanchored")
    # The same cart again, with what the agent saw this time, is the same purchase.
    resealed = await client.evidence.seal(
        mandate_id=mandate.id, sources={**q["sources"], "observation": "Pace Lite, size 10, $99.00."}
    )
    again = await client.purchases.countersign(mandate=mandate, evidence_root=resealed["evidenceRoot"], cart=q["cart"])
    assert again.existing and again.purchase_id == signed.purchase_id


async def test_the_quickstart_runs_within_budget(tmp_path: Path) -> None:
    path = tmp_path / "credentials.json"
    await login(path=path, open=lambda url: act("login", url, judge="quickstart"))
    env = {**os.environ, "KEELSON_CREDENTIALS": str(path), "KEELSON_VERIFY_COMMAND": f"node {VERIFY_CLI}"}
    started = time.monotonic()
    child = subprocess.Popen([sys.executable, str(EXAMPLE)], stdout=subprocess.PIPE, text=True, env=env)
    assert child.stdout is not None
    human = 0.0
    out = []
    for line in child.stdout:
        out.append(line)
        if line.startswith("Approve with your passkey: "):
            t = time.monotonic()
            act("hold", line.split(": ", 1)[1].strip(), judge="quickstart")
            human = time.monotonic() - t
    assert child.wait(timeout=300) == 0
    automated = time.monotonic() - started - human
    print(f"python quickstart: {automated:.1f} s automated")
    assert "Alibi: verified" in "".join(out)
    assert automated <= 90
