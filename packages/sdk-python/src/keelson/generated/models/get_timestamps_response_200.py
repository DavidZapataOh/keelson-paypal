from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.get_timestamps_response_200_pending_item import (
    GetTimestampsResponse200PendingItem,
    check_get_timestamps_response_200_pending_item,
)

if TYPE_CHECKING:
    from ..models.timestamp import Timestamp


T = TypeVar("T", bound="GetTimestampsResponse200")


@_attrs_define
class GetTimestampsResponse200:
    """
    Attributes:
        hash_ (str):
        stamps (list[Timestamp]):
        pending (list[GetTimestampsResponse200PendingItem]):
    """

    hash_: str
    stamps: list[Timestamp]
    pending: list[GetTimestampsResponse200PendingItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        hash_ = self.hash_

        stamps = []
        for stamps_item_data in self.stamps:
            stamps_item = stamps_item_data.to_dict()
            stamps.append(stamps_item)

        pending = []
        for pending_item_data in self.pending:
            pending_item: str = pending_item_data
            pending.append(pending_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "hash": hash_,
                "stamps": stamps,
                "pending": pending,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.timestamp import Timestamp

        d = dict(src_dict)
        hash_ = d.pop("hash")

        stamps = []
        _stamps = d.pop("stamps")
        for stamps_item_data in _stamps:
            stamps_item = Timestamp.from_dict(stamps_item_data)

            stamps.append(stamps_item)

        pending = []
        _pending = d.pop("pending")
        for pending_item_data in _pending:
            pending_item = check_get_timestamps_response_200_pending_item(pending_item_data)

            pending.append(pending_item)

        get_timestamps_response_200 = cls(
            hash_=hash_,
            stamps=stamps,
            pending=pending,
        )

        get_timestamps_response_200.additional_properties = d
        return get_timestamps_response_200

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
