from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.channel_3_observation_status import (
    Channel3ObservationStatus,
    check_channel_3_observation_status,
)

if TYPE_CHECKING:
    from ..models.channel_3_comparison import Channel3Comparison
    from ..models.channel_3_observation_item import Channel3ObservationItem


T = TypeVar("T", bound="Channel3Observation")


@_attrs_define
class Channel3Observation:
    """
    Attributes:
        id (str):
        status (Channel3ObservationStatus): `unavailable` when Channel3 did not answer in time or failed; it is stored
            too.
        item (Channel3ObservationItem): The sealed evidence item to add to the capture's items, after `har`, before
            `buildManifest` and `POST /v1/evidence`.
        comparison (Channel3Comparison):
    """

    id: str
    status: Channel3ObservationStatus
    item: Channel3ObservationItem
    comparison: Channel3Comparison
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        status: str = self.status

        item = self.item.to_dict()

        comparison = self.comparison.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "status": status,
                "item": item,
                "comparison": comparison,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.channel_3_comparison import Channel3Comparison
        from ..models.channel_3_observation_item import Channel3ObservationItem

        d = dict(src_dict)
        id = d.pop("id")

        status = check_channel_3_observation_status(d.pop("status"))

        item = Channel3ObservationItem.from_dict(d.pop("item"))

        comparison = Channel3Comparison.from_dict(d.pop("comparison"))

        channel_3_observation = cls(
            id=id,
            status=status,
            item=item,
            comparison=comparison,
        )

        channel_3_observation.additional_properties = d
        return channel_3_observation

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
