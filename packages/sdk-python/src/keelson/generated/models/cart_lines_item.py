from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="CartLinesItem")


@_attrs_define
class CartLinesItem:
    """
    Attributes:
        sku (str):
        category (str):
        qty (int):
        unit_minor (int):
        size (None | str | Unset):
        color (None | str | Unset):
    """

    sku: str
    category: str
    qty: int
    unit_minor: int
    size: str | Unset | None = UNSET
    color: str | Unset | None = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        sku = self.sku

        category = self.category

        qty = self.qty

        unit_minor = self.unit_minor

        size: str | Unset | None
        if isinstance(self.size, Unset):
            size = UNSET
        else:
            size = self.size

        color: str | Unset | None
        if isinstance(self.color, Unset):
            color = UNSET
        else:
            color = self.color

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "sku": sku,
                "category": category,
                "qty": qty,
                "unit_minor": unit_minor,
            }
        )
        if size is not UNSET:
            field_dict["size"] = size
        if color is not UNSET:
            field_dict["color"] = color

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        sku = d.pop("sku")

        category = d.pop("category")

        qty = d.pop("qty")

        unit_minor = d.pop("unit_minor")

        def _parse_size(data: object) -> str | Unset | None:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        size = _parse_size(d.pop("size", UNSET))

        def _parse_color(data: object) -> str | Unset | None:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        color = _parse_color(d.pop("color", UNSET))

        cart_lines_item = cls(
            sku=sku,
            category=category,
            qty=qty,
            unit_minor=unit_minor,
            size=size,
            color=color,
        )

        cart_lines_item.additional_properties = d
        return cart_lines_item

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
