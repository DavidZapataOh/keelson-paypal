from __future__ import annotations

import json
import os
import subprocess

import httpx2
import pytest

import keelson

from .conftest import VERIFY_CLI, live

pytestmark = [pytest.mark.live, live]


@pytest.fixture(autouse=True)
def local_verifier(monkeypatch: pytest.MonkeyPatch) -> None:
    if not os.environ.get("KEELSON_VERIFY_COMMAND"):
        monkeypatch.setenv("KEELSON_VERIFY_COMMAND", f"node {VERIFY_CLI}")


@pytest.fixture(scope="module")
def alibi() -> bytes:
    rows = httpx2.get("https://api.keelson.finance/v1/live-purchases", timeout=30).json()["purchases"]
    pid = next(p["id"] for p in rows if p["logIndex"] is not None)
    return httpx2.get(f"https://api.keelson.finance/v1/alibis/{pid}", timeout=60).content


def test_an_alibi_verifies_offline(alibi: bytes) -> None:
    report = keelson.verify_alibi(alibi)
    assert report["verdict"] in ("verified-offline", "verified-unanchored")
    assert not [c for c in report["checks"] if c["status"] == "fail"]


def test_the_verdict_equals_typescript_for_the_same_bytes(alibi: bytes) -> None:
    ts = json.loads(
        subprocess.run(["node", str(VERIFY_CLI), "--json", "-"], input=alibi, capture_output=True, check=True).stdout
    )
    mine = keelson.verify_alibi(alibi)
    assert [(c["id"], c["status"]) for c in mine["checks"]] == [(c["id"], c["status"]) for c in ts["checks"]]
    assert mine["verdict"] == ts["verdict"]


def test_a_parsed_alibi_verifies_the_same(alibi: bytes) -> None:
    assert keelson.verify_alibi(json.loads(alibi))["verdict"] == keelson.verify_alibi(alibi)["verdict"]


def test_a_tampered_alibi_fails(alibi: bytes) -> None:
    doc = json.loads(alibi)
    doc["alibi_id"] = doc["alibi_id"][:-1] + ("1" if doc["alibi_id"].endswith("0") else "0")
    assert keelson.verify_alibi(doc)["verdict"] == "failed"
