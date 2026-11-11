from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.channel_3_observation_request_agent_view_currency import (
    Channel3ObservationRequestAgentViewCurrency,
    check_channel_3_observation_request_agent_view_currency,
)
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.channel_3_observation_request_agent_view_selected_item import (
        Channel3ObservationRequestAgentViewSelectedItem,
    )


T = TypeVar("T", bound="Channel3ObservationRequestAgentView")


@_attrs_define
class Channel3ObservationRequestAgentView:
    """What the agent saw on the page.

    Attributes:
        content_hash (str): The `content_hash` of the capture's `api.product` item the view was read from.
        price_minor (str): The price the agent saw, in minor units.
        currency (Channel3ObservationRequestAgentViewCurrency):
        available (bool):
        selected (list[Channel3ObservationRequestAgentViewSelectedItem]):
        brand (str | Unset):
    """

    content_hash: str
    price_minor: str
    currency: Channel3ObservationRequestAgentViewCurrency
    available: bool
    selected: list[Channel3ObservationRequestAgentViewSelectedItem]
    brand: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        content_hash = self.content_hash

        price_minor = self.price_minor

        currency: str = self.currency

        available = self.available

        selected = []
        for selected_item_data in self.selected:
            selected_item = selected_item_data.to_dict()
            selected.append(selected_item)

        brand = self.brand

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "contentHash": content_hash,
                "priceMinor": price_minor,
                "currency": currency,
                "available": available,
                "selected": selected,
            }
        )
        if brand is not UNSET:
            field_dict["brand"] = brand

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.channel_3_observation_request_agent_view_selected_item import (
            Channel3ObservationRequestAgentViewSelectedItem,
        )

        d = dict(src_dict)
        content_hash = d.pop("contentHash")

        price_minor = d.pop("priceMinor")

        currency = check_channel_3_observation_request_agent_view_currency(d.pop("currency"))

        available = d.pop("available")

        selected = []
        _selected = d.pop("selected")
        for selected_item_data in _selected:
            selected_item = Channel3ObservationRequestAgentViewSelectedItem.from_dict(
                selected_item_data
            )

            selected.append(selected_item)

        brand = d.pop("brand", UNSET)

        channel_3_observation_request_agent_view = cls(
            content_hash=content_hash,
            price_minor=price_minor,
            currency=currency,
            available=available,
            selected=selected,
            brand=brand,
        )

        channel_3_observation_request_agent_view.additional_properties = d
        return channel_3_observation_request_agent_view

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
