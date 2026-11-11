from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="EvidenceDisclosure")


@_attrs_define
class EvidenceDisclosure:
    """
    Attributes:
        index (int):
        type_ (str):
        media_type (str):
        content_hash (str):
        salt (str):
        path (list[str]): The RFC 9162 inclusion proof, leaf first.
        size (int):
    """

    index: int
    type_: str
    media_type: str
    content_hash: str
    salt: str
    path: list[str]
    size: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        index = self.index

        type_ = self.type_

        media_type = self.media_type

        content_hash = self.content_hash

        salt = self.salt

        path = self.path

        size = self.size

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "index": index,
                "type": type_,
                "media_type": media_type,
                "content_hash": content_hash,
                "salt": salt,
                "path": path,
                "size": size,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        index = d.pop("index")

        type_ = d.pop("type")

        media_type = d.pop("media_type")

        content_hash = d.pop("content_hash")

        salt = d.pop("salt")

        path = cast(list[str], d.pop("path"))

        size = d.pop("size")

        evidence_disclosure = cls(
            index=index,
            type_=type_,
            media_type=media_type,
            content_hash=content_hash,
            salt=salt,
            path=path,
            size=size,
        )

        evidence_disclosure.additional_properties = d
        return evidence_disclosure

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
