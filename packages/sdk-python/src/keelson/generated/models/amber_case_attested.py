from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="AmberCaseAttested")


@_attrs_define
class AmberCaseAttested:
    """
    Attributes:
        url (str): The store's JSON page for the SKU.
        sku (str):
        size (str):
        color (str):
        unit_minor (str):
        returns_free (bool):
    """

    url: str
    sku: str
    size: str
    color: str
    unit_minor: str
    returns_free: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        url = self.url

        sku = self.sku

        size = self.size

        color = self.color

        unit_minor = self.unit_minor

        returns_free = self.returns_free

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "url": url,
                "sku": sku,
                "size": size,
                "color": color,
                "unit_minor": unit_minor,
                "returns_free": returns_free,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        url = d.pop("url")

        sku = d.pop("sku")

        size = d.pop("size")

        color = d.pop("color")

        unit_minor = d.pop("unit_minor")

        returns_free = d.pop("returns_free")

        amber_case_attested = cls(
            url=url,
            sku=sku,
            size=size,
            color=color,
            unit_minor=unit_minor,
            returns_free=returns_free,
        )

        amber_case_attested.additional_properties = d
        return amber_case_attested

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
