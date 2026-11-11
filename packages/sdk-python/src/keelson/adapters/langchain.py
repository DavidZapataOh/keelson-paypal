"""Keelson's tools for LangChain and LangGraph: bind them to a model or an agent."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from .._tools import KeelsonTool, tools

if TYPE_CHECKING:
    from .._client import AsyncKeelson

try:
    from langchain_core.tools import StructuredTool
except ImportError as err:  # pragma: no cover - depends on the extra
    raise ImportError("pip install keelson-finance[langchain]") from err


def _wrap(t: KeelsonTool) -> StructuredTool:
    async def run(**arguments: Any) -> str:
        return json.dumps(await t.execute(arguments))

    return StructuredTool.from_function(
        coroutine=run, name=t.name, description=t.description, args_schema=t.input_schema
    )


def langchain_tools(client: AsyncKeelson, *, agent_id: str | None = None) -> list[StructuredTool]:
    return [_wrap(t) for t in tools(client, agent_id=agent_id)]
