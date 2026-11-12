from __future__ import annotations

import json
from typing import Any

import httpx2
import pytest

import keelson
from keelson.adapters.claude_agent_sdk import keelson_mcp_server, keelson_sdk_tools
from keelson.adapters.langchain import langchain_tools
from keelson.adapters.openai_agents import openai_agents_tools

from .conftest import live

pytestmark = [pytest.mark.live, live]


@pytest.fixture(scope="module")
def purchase_id() -> str:
    rows = httpx2.get("https://api.keelson.finance/v1/live-purchases", timeout=30).json()["purchases"]
    return str(next(p["id"] for p in rows if p["logIndex"] is not None))


def verified(answer: Any) -> None:
    a = json.loads(answer) if isinstance(answer, str) else answer
    assert a["verdict"] in ("verified", "verified-unanchored")


async def test_openai_agents(purchase_id: str) -> None:
    t = next(x for x in openai_agents_tools(keelson.AsyncKeelson(None)) if x.name == "keelson_verify_alibi")
    verified(await t.on_invoke_tool(None, json.dumps({"purchaseId": purchase_id})))  # type: ignore[arg-type]


async def test_langchain(purchase_id: str) -> None:
    t = next(x for x in langchain_tools(keelson.AsyncKeelson(None)) if x.name == "keelson_verify_alibi")
    verified(await t.ainvoke({"purchaseId": purchase_id}))


async def test_claude_agent_sdk(purchase_id: str) -> None:
    client = keelson.AsyncKeelson(None)
    assert keelson_mcp_server(client)["type"] == "sdk"
    t = next(x for x in keelson_sdk_tools(client) if x.name == "keelson_verify_alibi")
    verified((await t.handler({"purchaseId": purchase_id}))["structuredContent"])
