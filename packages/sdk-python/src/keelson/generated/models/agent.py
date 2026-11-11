from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.agent_mandate import AgentMandate


T = TypeVar("T", bound="Agent")


@_attrs_define
class Agent:
    """
    Attributes:
        agent_id (str):
        client_id (None | str): The app acting through Keelson's hosted operator, which many apps share: disconnect it
            alone with `?client=`. Null for an agent's own operator, and for the hosted operator's mandates no app holds
            (`Unknown app`).
        name (str):
        operator (str):
        connected (bool):
        mandate (AgentMandate | None): The live mandate the agent buys under, if any.
        last_activity_at (str):
    """

    agent_id: str
    client_id: str | None
    name: str
    operator: str
    connected: bool
    mandate: AgentMandate | None
    last_activity_at: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.agent_mandate import AgentMandate

        agent_id = self.agent_id

        client_id: str | None
        client_id = self.client_id

        name = self.name

        operator = self.operator

        connected = self.connected

        mandate: dict[str, Any] | None
        if isinstance(self.mandate, AgentMandate):
            mandate = self.mandate.to_dict()
        else:
            mandate = self.mandate

        last_activity_at = self.last_activity_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "agentId": agent_id,
                "clientId": client_id,
                "name": name,
                "operator": operator,
                "connected": connected,
                "mandate": mandate,
                "lastActivityAt": last_activity_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.agent_mandate import AgentMandate

        d = dict(src_dict)
        agent_id = d.pop("agentId")

        def _parse_client_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        client_id = _parse_client_id(d.pop("clientId"))

        name = d.pop("name")

        operator = d.pop("operator")

        connected = d.pop("connected")

        def _parse_mandate(data: object) -> AgentMandate | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                mandate_type_0 = AgentMandate.from_dict(data)

                return mandate_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(AgentMandate | None, data)

        mandate = _parse_mandate(d.pop("mandate"))

        last_activity_at = d.pop("lastActivityAt")

        agent = cls(
            agent_id=agent_id,
            client_id=client_id,
            name=name,
            operator=operator,
            connected=connected,
            mandate=mandate,
            last_activity_at=last_activity_at,
        )

        agent.additional_properties = d
        return agent

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
