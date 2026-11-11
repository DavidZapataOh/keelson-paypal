from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="CountersignRequestUnit")


@_attrs_define
class CountersignRequestUnit:
    """The PayPal purchase unit the cart is checked against: `{amount}`, the checkout total the buyer pays as a PayPal
    Orders v2 amount, whose `breakdown` has the `item_total` of the cart's lines and, when the checkout charges them,
    `tax_total`, `shipping` and `discount`. Keelson countersigns `amount.value`, which must be `item_total + tax_total +
    shipping − discount`, and checks it against the mandate's budget. `handling`, `insurance` and `shipping_discount`
    are refused: fold them into `shipping`.

    """

    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        countersign_request_unit = cls()

        countersign_request_unit.additional_properties = d
        return countersign_request_unit

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
