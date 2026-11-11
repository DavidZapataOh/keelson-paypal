from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

LIVE = os.environ.get("KEELSON_LIVE") == "1"
HAS_BUYER = bool(os.environ.get("PAYPAL_SANDBOX_BUYER_EMAIL") and os.environ.get("PAYPAL_SANDBOX_BUYER_PASSWORD"))
_APPROVE = Path(__file__).resolve().parents[3] / "sdk" / "test" / "live" / "approve.ts"

live = pytest.mark.skipif(not LIVE, reason="set KEELSON_LIVE=1 to call Keelson's live sandbox")
needs_buyer = pytest.mark.skipif(not HAS_BUYER, reason="needs the PayPal sandbox buyer")


def act(command: str, url: str) -> None:
    """Plays the user in a real browser, through the TypeScript SDK's live helper."""
    subprocess.run(["node", str(_APPROVE), command, url], check=True, timeout=300)
