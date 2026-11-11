from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="EvidenceManifestItemsItem")


@_attrs_define
class EvidenceManifestItemsItem:
    """
    Attributes:
        type_ (str):
        media_type (str):
        leaf (str): `SHA-256(0x00 ‖ "keelson/evidence-item/v1" ‖ salt ‖ type ‖ 0x00 ‖ media_type ‖ 0x00 ‖
            content_hash)`.
    """

    type_: str
    media_type: str
    leaf: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_

        media_type = self.media_type

        leaf = self.leaf

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "type": type_,
                "media_type": media_type,
                "leaf": leaf,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = d.pop("type")

        media_type = d.pop("media_type")

        leaf = d.pop("leaf")

        evidence_manifest_items_item = cls(
            type_=type_,
            media_type=media_type,
            leaf=leaf,
        )

        evidence_manifest_items_item.additional_properties = d
        return evidence_manifest_items_item

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
