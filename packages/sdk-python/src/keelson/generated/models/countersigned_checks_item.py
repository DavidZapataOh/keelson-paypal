from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="CountersignedChecksItem")


@_attrs_define
class CountersignedChecksItem:
    """
    Attributes:
        field (str):
        mandate (None | str):
        cart (None | str):
        pass_ (bool):
    """

    field: str
    mandate: str | None
    cart: str | None
    pass_: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        field = self.field

        mandate: str | None
        mandate = self.mandate

        cart: str | None
        cart = self.cart

        pass_ = self.pass_

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "field": field,
                "mandate": mandate,
                "cart": cart,
                "pass": pass_,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        field = d.pop("field")

        def _parse_mandate(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        mandate = _parse_mandate(d.pop("mandate"))

        def _parse_cart(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        cart = _parse_cart(d.pop("cart"))

        pass_ = d.pop("pass")

        countersigned_checks_item = cls(
            field=field,
            mandate=mandate,
            cart=cart,
            pass_=pass_,
        )

        countersigned_checks_item.additional_properties = d
        return countersigned_checks_item

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
