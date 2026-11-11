"""Keelson's tools for the OpenAI Agents SDK: ``Agent(tools=openai_agents_tools(client))``."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from .._tools import KeelsonTool, tools

if TYPE_CHECKING:
    from .._client import AsyncKeelson

try:
    from agents import FunctionTool
except ImportError as err:  # pragma: no cover - depends on the extra
    raise ImportError("pip install keelson-finance[openai-agents]") from err


def _wrap(t: KeelsonTool) -> FunctionTool:
    async def invoke(_ctx: Any, arguments: str) -> str:
        return json.dumps(await t.execute(json.loads(arguments or "{}")))

    return FunctionTool(
        name=t.name,
        description=t.description,
        params_json_schema=t.input_schema,
        on_invoke_tool=invoke,
        strict_json_schema=False,
    )


def openai_agents_tools(client: AsyncKeelson, *, agent_id: str | None = None) -> list[FunctionTool]:
    return [_wrap(t) for t in tools(client, agent_id=agent_id)]
