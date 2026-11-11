from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="MandateDraftAgentOperator")


@_attrs_define
class MandateDraftAgentOperator:
    """
    Attributes:
        agent_registry (str):
        agent_id (str):
    """

    agent_registry: str
    agent_id: str

    def to_dict(self) -> dict[str, Any]:
        agent_registry = self.agent_registry

        agent_id = self.agent_id

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "agent_registry": agent_registry,
                "agent_id": agent_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        agent_registry = d.pop("agent_registry")

        agent_id = d.pop("agent_id")

        mandate_draft_agent_operator = cls(
            agent_registry=agent_registry,
            agent_id=agent_id,
        )

        return mandate_draft_agent_operator
