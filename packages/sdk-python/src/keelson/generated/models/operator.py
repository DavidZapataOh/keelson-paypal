from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="Operator")


@_attrs_define
class Operator:
    """
    Attributes:
        agent_id (str): The ERC-8004 agent id, a decimal integer.
        chain_id (int):
        agent_registry (str):
        owner (str): The agent's owner in the Identity registry.
    """

    agent_id: str
    chain_id: int
    agent_registry: str
    owner: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        agent_id = self.agent_id

        chain_id = self.chain_id

        agent_registry = self.agent_registry

        owner = self.owner

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "agentId": agent_id,
                "chainId": chain_id,
                "agentRegistry": agent_registry,
                "owner": owner,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        agent_id = d.pop("agentId")

        chain_id = d.pop("chainId")

        agent_registry = d.pop("agentRegistry")

        owner = d.pop("owner")

        operator = cls(
            agent_id=agent_id,
            chain_id=chain_id,
            agent_registry=agent_registry,
            owner=owner,
        )

        operator.additional_properties = d
        return operator

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
