from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="CheckoutBreakdown")


@_attrs_define
class CheckoutBreakdown:
    """What the countersigned total is made of, in minor units: the items, plus tax and shipping, less discounts. Absent
    for purchases countersigned without it.

        Attributes:
            items (str):
            tax (str):
            shipping (str):
            discount (str):
    """

    items: str
    tax: str
    shipping: str
    discount: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        items = self.items

        tax = self.tax

        shipping = self.shipping

        discount = self.discount

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "items": items,
                "tax": tax,
                "shipping": shipping,
                "discount": discount,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        items = d.pop("items")

        tax = d.pop("tax")

        shipping = d.pop("shipping")

        discount = d.pop("discount")

        checkout_breakdown = cls(
            items=items,
            tax=tax,
            shipping=shipping,
            discount=discount,
        )

        checkout_breakdown.additional_properties = d
        return checkout_breakdown

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
