"""Keelson's tools as an in-process MCP server for the Claude Agent SDK:
``ClaudeAgentOptions(mcp_servers={"keelson": keelson_mcp_server(client)})``."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .._tools import KeelsonTool, tools

if TYPE_CHECKING:
    from .._client import AsyncKeelson

try:
    from claude_agent_sdk import McpSdkServerConfig, SdkMcpTool, create_sdk_mcp_server, tool
except ImportError as err:  # pragma: no cover - depends on the extra
    raise ImportError("pip install keelson-finance[claude-agent-sdk]") from err


def _wrap(t: KeelsonTool) -> SdkMcpTool[Any]:
    async def handler(arguments: dict[str, Any]) -> dict[str, Any]:
        envelope = await t.execute(arguments)
        return {
            "content": [{"type": "text", "text": f"{envelope['message']}\nNext: {envelope['next']['say']}"}],
            "structuredContent": envelope,
            **({"is_error": True} if envelope["status"] == "error" else {}),
        }

    return tool(t.name, t.description, t.input_schema)(handler)


def keelson_sdk_tools(client: AsyncKeelson, *, agent_id: str | None = None) -> list[SdkMcpTool[Any]]:
    """The tools the server offers, for an SDK MCP server of your own."""
    return [_wrap(t) for t in tools(client, agent_id=agent_id)]


def keelson_mcp_server(client: AsyncKeelson, *, agent_id: str | None = None) -> McpSdkServerConfig:
    return create_sdk_mcp_server(name="keelson", tools=keelson_sdk_tools(client, agent_id=agent_id))
