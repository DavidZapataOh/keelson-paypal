from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="ConnectionCartLinesItem")


@_attrs_define
class ConnectionCartLinesItem:
    """
    Attributes:
        sku (str):
        size (None | str):
        color (None | str):
        category (str):
        qty (int):
        unit_minor (str):
    """

    sku: str
    size: str | None
    color: str | None
    category: str
    qty: int
    unit_minor: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        sku = self.sku

        size: str | None
        size = self.size

        color: str | None
        color = self.color

        category = self.category

        qty = self.qty

        unit_minor = self.unit_minor

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "sku": sku,
                "size": size,
                "color": color,
                "category": category,
                "qty": qty,
                "unitMinor": unit_minor,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        sku = d.pop("sku")

        def _parse_size(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        size = _parse_size(d.pop("size"))

        def _parse_color(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        color = _parse_color(d.pop("color"))

        category = d.pop("category")

        qty = d.pop("qty")

        unit_minor = d.pop("unitMinor")

        connection_cart_lines_item = cls(
            sku=sku,
            size=size,
            color=color,
            category=category,
            qty=qty,
            unit_minor=unit_minor,
        )

        connection_cart_lines_item.additional_properties = d
        return connection_cart_lines_item

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
