from __future__ import annotations

import builtins
import importlib
import sys
from typing import Any

import pytest

import keelson


async def test_a_failure_is_an_envelope_never_an_exception() -> None:
    get_request = next(t for t in keelson.tools(keelson.AsyncKeelson(None)) if t.name == "keelson_get_request")
    answer = await get_request.execute({"requestId": "01JX0000000000000000000000"})
    assert answer["status"] == "error" and answer["retryable"] is False
    assert answer["next"]["action"] == "tell_user"


@pytest.mark.parametrize(
    ("module", "extra", "package"),
    [
        ("keelson.adapters.openai_agents", "openai-agents", "agents"),
        ("keelson.adapters.langchain", "langchain", "langchain_core"),
        ("keelson.adapters.claude_agent_sdk", "claude-agent-sdk", "claude_agent_sdk"),
    ],
)
def test_a_missing_framework_names_its_extra(
    monkeypatch: pytest.MonkeyPatch, module: str, extra: str, package: str
) -> None:
    real = builtins.__import__

    def blocked(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == package or name.startswith(f"{package}."):
            raise ImportError(name)
        return real(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked)
    monkeypatch.delitem(sys.modules, module, raising=False)
    with pytest.raises(ImportError, match=f"keelson-finance\\[{extra}\\]"):
        importlib.import_module(module)
