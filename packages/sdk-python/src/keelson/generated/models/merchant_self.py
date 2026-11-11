from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="MerchantSelf")


@_attrs_define
class MerchantSelf:
    """
    Attributes:
        merchant_id (str):
        name (str):
        website (str):
        settlement_address (str): The wallet the merchant signs in and signs its choices with.
        read_only (bool): True for a Judge Mode session: it reads the console and changes nothing.
    """

    merchant_id: str
    name: str
    website: str
    settlement_address: str
    read_only: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        merchant_id = self.merchant_id

        name = self.name

        website = self.website

        settlement_address = self.settlement_address

        read_only = self.read_only

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "merchant_id": merchant_id,
                "name": name,
                "website": website,
                "settlement_address": settlement_address,
                "read_only": read_only,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        merchant_id = d.pop("merchant_id")

        name = d.pop("name")

        website = d.pop("website")

        settlement_address = d.pop("settlement_address")

        read_only = d.pop("read_only")

        merchant_self = cls(
            merchant_id=merchant_id,
            name=name,
            website=website,
            settlement_address=settlement_address,
            read_only=read_only,
        )

        merchant_self.additional_properties = d
        return merchant_self

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
