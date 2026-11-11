from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.cart_lines_item import CartLinesItem


T = TypeVar("T", bound="Cart")


@_attrs_define
class Cart:
    """
    Attributes:
        merchant (str):
        currency (str):
        lines (list[CartLinesItem]):
        return_days (int):
        returns_free (bool):
    """

    merchant: str
    currency: str
    lines: list[CartLinesItem]
    return_days: int
    returns_free: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        merchant = self.merchant

        currency = self.currency

        lines = []
        for lines_item_data in self.lines:
            lines_item = lines_item_data.to_dict()
            lines.append(lines_item)

        return_days = self.return_days

        returns_free = self.returns_free

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "merchant": merchant,
                "currency": currency,
                "lines": lines,
                "return_days": return_days,
                "returns_free": returns_free,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.cart_lines_item import CartLinesItem

        d = dict(src_dict)
        merchant = d.pop("merchant")

        currency = d.pop("currency")

        lines = []
        _lines = d.pop("lines")
        for lines_item_data in _lines:
            lines_item = CartLinesItem.from_dict(lines_item_data)

            lines.append(lines_item)

        return_days = d.pop("return_days")

        returns_free = d.pop("returns_free")

        cart = cls(
            merchant=merchant,
            currency=currency,
            lines=lines,
            return_days=return_days,
            returns_free=returns_free,
        )

        cart.additional_properties = d
        return cart

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
