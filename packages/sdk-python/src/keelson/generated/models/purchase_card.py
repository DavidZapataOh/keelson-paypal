from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="PurchaseCard")


@_attrs_define
class PurchaseCard:
    """
    Attributes:
        last_four (str):
        expires_at (str):
        embed_url (str):
    """

    last_four: str
    expires_at: str
    embed_url: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        last_four = self.last_four

        expires_at = self.expires_at

        embed_url = self.embed_url

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "lastFour": last_four,
                "expiresAt": expires_at,
                "embedUrl": embed_url,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        last_four = d.pop("lastFour")

        expires_at = d.pop("expiresAt")

        embed_url = d.pop("embedUrl")

        purchase_card = cls(
            last_four=last_four,
            expires_at=expires_at,
            embed_url=embed_url,
        )

        purchase_card.additional_properties = d
        return purchase_card

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
