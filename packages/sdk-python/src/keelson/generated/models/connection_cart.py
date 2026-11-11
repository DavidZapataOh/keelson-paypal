from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.connection_cart_lines_item import ConnectionCartLinesItem
    from ..models.connection_cart_merchant import ConnectionCartMerchant


T = TypeVar("T", bound="ConnectionCart")


@_attrs_define
class ConnectionCart:
    """
    Attributes:
        merchant (ConnectionCartMerchant):
        currency (str):
        total_minor (str):
        lines (list[ConnectionCartLinesItem]):
    """

    merchant: ConnectionCartMerchant
    currency: str
    total_minor: str
    lines: list[ConnectionCartLinesItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        merchant = self.merchant.to_dict()

        currency = self.currency

        total_minor = self.total_minor

        lines = []
        for lines_item_data in self.lines:
            lines_item = lines_item_data.to_dict()
            lines.append(lines_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "merchant": merchant,
                "currency": currency,
                "totalMinor": total_minor,
                "lines": lines,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.connection_cart_lines_item import ConnectionCartLinesItem
        from ..models.connection_cart_merchant import ConnectionCartMerchant

        d = dict(src_dict)
        merchant = ConnectionCartMerchant.from_dict(d.pop("merchant"))

        currency = d.pop("currency")

        total_minor = d.pop("totalMinor")

        lines = []
        _lines = d.pop("lines")
        for lines_item_data in _lines:
            lines_item = ConnectionCartLinesItem.from_dict(lines_item_data)

            lines.append(lines_item)

        connection_cart = cls(
            merchant=merchant,
            currency=currency,
            total_minor=total_minor,
            lines=lines,
        )

        connection_cart.additional_properties = d
        return connection_cart

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
