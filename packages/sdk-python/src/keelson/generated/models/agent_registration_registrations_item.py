from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="AgentRegistrationRegistrationsItem")


@_attrs_define
class AgentRegistrationRegistrationsItem:
    """
    Attributes:
        agent_id (float | str):
        agent_registry (str):
    """

    agent_id: float | str
    agent_registry: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        agent_id: float | str
        agent_id = self.agent_id

        agent_registry = self.agent_registry

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "agentId": agent_id,
                "agentRegistry": agent_registry,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)

        def _parse_agent_id(data: object) -> float | str:
            return cast(float | str, data)

        agent_id = _parse_agent_id(d.pop("agentId"))

        agent_registry = d.pop("agentRegistry")

        agent_registration_registrations_item = cls(
            agent_id=agent_id,
            agent_registry=agent_registry,
        )

        agent_registration_registrations_item.additional_properties = d
        return agent_registration_registrations_item

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
