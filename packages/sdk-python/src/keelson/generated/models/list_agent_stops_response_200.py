from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.agent_stop import AgentStop


T = TypeVar("T", bound="ListAgentStopsResponse200")


@_attrs_define
class ListAgentStopsResponse200:
    """
    Attributes:
        stops (list[AgentStop]):
    """

    stops: list[AgentStop]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        stops = []
        for stops_item_data in self.stops:
            stops_item = stops_item_data.to_dict()
            stops.append(stops_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "stops": stops,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.agent_stop import AgentStop

        d = dict(src_dict)
        stops = []
        _stops = d.pop("stops")
        for stops_item_data in _stops:
            stops_item = AgentStop.from_dict(stops_item_data)

            stops.append(stops_item)

        list_agent_stops_response_200 = cls(
            stops=stops,
        )

        list_agent_stops_response_200.additional_properties = d
        return list_agent_stops_response_200

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
