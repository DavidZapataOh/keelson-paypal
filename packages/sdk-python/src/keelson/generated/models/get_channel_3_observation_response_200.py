from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.get_channel_3_observation_response_200_document import (
        GetChannel3ObservationResponse200Document,
    )


T = TypeVar("T", bound="GetChannel3ObservationResponse200")


@_attrs_define
class GetChannel3ObservationResponse200:
    """
    Attributes:
        document (GetChannel3ObservationResponse200Document): The `keelson.channel3.observation/1` document; its JCS
            bytes hash to `content_hash`.
        content_hash (str):
    """

    document: GetChannel3ObservationResponse200Document
    content_hash: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        document = self.document.to_dict()

        content_hash = self.content_hash

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "document": document,
                "content_hash": content_hash,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.get_channel_3_observation_response_200_document import (
            GetChannel3ObservationResponse200Document,
        )

        d = dict(src_dict)
        document = GetChannel3ObservationResponse200Document.from_dict(d.pop("document"))

        content_hash = d.pop("content_hash")

        get_channel_3_observation_response_200 = cls(
            document=document,
            content_hash=content_hash,
        )

        get_channel_3_observation_response_200.additional_properties = d
        return get_channel_3_observation_response_200

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
