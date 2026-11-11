from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="CartCheckBlockersItem")


@_attrs_define
class CartCheckBlockersItem:
    """
    Attributes:
        code (str):  Example: field:total.
        field (None | str):
        message (str):
        next_ (str): What the agent does about it.
    """

    code: str
    field: str | None
    message: str
    next_: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        code = self.code

        field: str | None
        field = self.field

        message = self.message

        next_ = self.next_

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "code": code,
                "field": field,
                "message": message,
                "next": next_,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        code = d.pop("code")

        def _parse_field(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        field = _parse_field(d.pop("field"))

        message = d.pop("message")

        next_ = d.pop("next")

        cart_check_blockers_item = cls(
            code=code,
            field=field,
            message=message,
            next_=next_,
        )

        cart_check_blockers_item.additional_properties = d
        return cart_check_blockers_item

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
