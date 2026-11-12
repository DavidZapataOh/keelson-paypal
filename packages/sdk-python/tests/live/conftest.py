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

live = pytest.mark.skipif(not LIVE, reason="set KEELSON_LIVE=1 to call Keelson's live sandbox")
needs_buyer = pytest.mark.skipif(not HAS_BUYER, reason="needs the PayPal sandbox buyer")


def act(command: str, url: str, judge: str | None = None) -> None:
    """Plays the user in a real browser, through the TypeScript SDK's live helper.

    ``judge`` names a Judge Mode user of its own, for a suite that buys: the hosted operator caps
    what one user may spend through apps it does not know.
    """
    env = dict(os.environ)
    if judge:
        env["KEELSON_LIVE_JUDGE"] = os.path.join(tempfile.gettempdir(), f"keelson-live-judge-py-{judge}.json")
    subprocess.run(["node", str(_APPROVE), command, url], check=True, timeout=300, env=env)
