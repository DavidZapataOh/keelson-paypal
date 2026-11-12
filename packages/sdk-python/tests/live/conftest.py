from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import pytest

LIVE = os.environ.get("KEELSON_LIVE") == "1"
HAS_BUYER = bool(os.environ.get("PAYPAL_SANDBOX_BUYER_EMAIL") and os.environ.get("PAYPAL_SANDBOX_BUYER_PASSWORD"))
_APPROVE = Path(__file__).resolve().parents[3] / "sdk" / "test" / "live" / "approve.ts"
VERIFY_CLI = Path(__file__).resolve().parents[3] / "verify" / "dist" / "cli.js"

# In CI one Judge Mode user serves the run and makes the one purchase KEELSON_LIVE_BUY names
# (see the TypeScript helper); unset, every buying test runs as a user of its own.
BUY = os.environ.get("KEELSON_LIVE_BUY")

live = pytest.mark.skipif(not LIVE, reason="set KEELSON_LIVE=1 to call Keelson's live sandbox")
needs_buyer = pytest.mark.skipif(not HAS_BUYER, reason="needs the PayPal sandbox buyer")


def buys(suite: str) -> pytest.MarkDecorator:
    return pytest.mark.skipif(BUY is not None and suite != BUY, reason=f"this run buys {BUY}")


def act(command: str, url: str, judge: str | None = None) -> None:
    """Plays the user in a real browser, through the TypeScript SDK's live helper.

    ``judge`` names a Judge Mode user of its own, for a suite that buys: the hosted operator caps
    what one user may spend through apps it does not know.
    """
    env = dict(os.environ)
    if judge and BUY is None:
        env["KEELSON_LIVE_JUDGE"] = os.path.join(tempfile.gettempdir(), f"keelson-live-judge-py-{judge}.json")
    subprocess.run(["node", str(_APPROVE), command, url], check=True, timeout=300, env=env)
