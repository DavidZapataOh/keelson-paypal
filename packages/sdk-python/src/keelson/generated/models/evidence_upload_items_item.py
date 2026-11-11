from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="EvidenceUploadItemsItem")


@_attrs_define
class EvidenceUploadItemsItem:
    """
    Attributes:
        type_ (str):
        media_type (str):
        salt (str): 32 random bytes, base64.
        bytes_ (str): The item bytes, base64.
    """

    type_: str
    media_type: str
    salt: str
    bytes_: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_

        media_type = self.media_type

        salt = self.salt

        bytes_ = self.bytes_

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "type": type_,
                "mediaType": media_type,
                "salt": salt,
                "bytes": bytes_,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = d.pop("type")

        media_type = d.pop("mediaType")

        salt = d.pop("salt")

        bytes_ = d.pop("bytes")

        evidence_upload_items_item = cls(
            type_=type_,
            media_type=media_type,
            salt=salt,
            bytes_=bytes_,
        )

        evidence_upload_items_item.additional_properties = d
        return evidence_upload_items_item

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
