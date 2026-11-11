from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.connection_agent_bond_type_0 import ConnectionAgentBondType0


T = TypeVar("T", bound="ConnectionAgent")


@_attrs_define
class ConnectionAgent:
    """
    Attributes:
        agent_id (str):
        operator (str):
        bond (ConnectionAgentBondType0 | None):
    """

    agent_id: str
    operator: str
    bond: ConnectionAgentBondType0 | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.connection_agent_bond_type_0 import ConnectionAgentBondType0

        agent_id = self.agent_id

        operator = self.operator

        bond: dict[str, Any] | None
        if isinstance(self.bond, ConnectionAgentBondType0):
            bond = self.bond.to_dict()
        else:
            bond = self.bond

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "agentId": agent_id,
                "operator": operator,
                "bond": bond,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.connection_agent_bond_type_0 import ConnectionAgentBondType0

        d = dict(src_dict)
        agent_id = d.pop("agentId")

        operator = d.pop("operator")

        def _parse_bond(data: object) -> ConnectionAgentBondType0 | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                bond_type_0 = ConnectionAgentBondType0.from_dict(data)

                return bond_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(ConnectionAgentBondType0 | None, data)

        bond = _parse_bond(d.pop("bond"))

        connection_agent = cls(
            agent_id=agent_id,
            operator=operator,
            bond=bond,
        )

        connection_agent.additional_properties = d
        return connection_agent

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
