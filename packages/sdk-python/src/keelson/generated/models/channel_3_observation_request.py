from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.channel_3_observation_request_agent_view import (
        Channel3ObservationRequestAgentView,
    )


T = TypeVar("T", bound="Channel3ObservationRequest")


@_attrs_define
class Channel3ObservationRequest:
    """
    Attributes:
        mandate_id (str):
        url (str): The product page the agent is on.
        agent_view (Channel3ObservationRequestAgentView): What the agent saw on the page.
    """

    mandate_id: str
    url: str
    agent_view: Channel3ObservationRequestAgentView
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        mandate_id = self.mandate_id

        url = self.url

        agent_view = self.agent_view.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "mandateId": mandate_id,
                "url": url,
                "agentView": agent_view,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.channel_3_observation_request_agent_view import (
            Channel3ObservationRequestAgentView,
        )

        d = dict(src_dict)
        mandate_id = d.pop("mandateId")

        url = d.pop("url")

        agent_view = Channel3ObservationRequestAgentView.from_dict(d.pop("agentView"))

        channel_3_observation_request = cls(
            mandate_id=mandate_id,
            url=url,
            agent_view=agent_view,
        )

        channel_3_observation_request.additional_properties = d
        return channel_3_observation_request

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
