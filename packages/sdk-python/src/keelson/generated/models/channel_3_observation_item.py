from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.channel_3_observation_item_media_type import (
    Channel3ObservationItemMediaType,
    check_channel_3_observation_item_media_type,
)
from ..models.channel_3_observation_item_type import (
    Channel3ObservationItemType,
    check_channel_3_observation_item_type,
)

T = TypeVar("T", bound="Channel3ObservationItem")


@_attrs_define
class Channel3ObservationItem:
    """The sealed evidence item to add to the capture's items, after `har`, before `buildManifest` and `POST /v1/evidence`.

    Attributes:
        type_ (Channel3ObservationItemType):
        media_type (Channel3ObservationItemMediaType):
        salt (str): 32 random bytes, base64.
        bytes_ (str): The JCS observation document, base64.
        content_hash (str):
        leaf (str):
    """

    type_: Channel3ObservationItemType
    media_type: Channel3ObservationItemMediaType
    salt: str
    bytes_: str
    content_hash: str
    leaf: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_: str = self.type_

        media_type: str = self.media_type

        salt = self.salt

        bytes_ = self.bytes_

        content_hash = self.content_hash

        leaf = self.leaf

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "type": type_,
                "mediaType": media_type,
                "salt": salt,
                "bytes": bytes_,
                "content_hash": content_hash,
                "leaf": leaf,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = check_channel_3_observation_item_type(d.pop("type"))

        media_type = check_channel_3_observation_item_media_type(d.pop("mediaType"))

        salt = d.pop("salt")

        bytes_ = d.pop("bytes")

        content_hash = d.pop("content_hash")

        leaf = d.pop("leaf")

        channel_3_observation_item = cls(
            type_=type_,
            media_type=media_type,
            salt=salt,
            bytes_=bytes_,
            content_hash=content_hash,
            leaf=leaf,
        )

        channel_3_observation_item.additional_properties = d
        return channel_3_observation_item

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
