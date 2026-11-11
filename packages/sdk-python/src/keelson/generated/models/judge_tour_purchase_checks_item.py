from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="JudgeTourPurchaseChecksItem")


@_attrs_define
class JudgeTourPurchaseChecksItem:
    """
    Attributes:
        field (str):
        color (str):
        pass_ (bool):
    """

    field: str
    color: str
    pass_: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        field = self.field

        color = self.color

        pass_ = self.pass_

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "field": field,
                "color": color,
                "pass": pass_,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        field = d.pop("field")

        color = d.pop("color")

        pass_ = d.pop("pass")

        judge_tour_purchase_checks_item = cls(
            field=field,
            color=color,
            pass_=pass_,
        )

        judge_tour_purchase_checks_item.additional_properties = d
        return judge_tour_purchase_checks_item

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
