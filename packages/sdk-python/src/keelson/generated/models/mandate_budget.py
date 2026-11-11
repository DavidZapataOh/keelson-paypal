from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="MandateBudget")


@_attrs_define
class MandateBudget:
    """The mandate's budget and what is left of it, in minor units.

    Attributes:
        currency (str):
        max_minor (str):
        remaining_minor (str):
    """

    currency: str
    max_minor: str
    remaining_minor: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        currency = self.currency

        max_minor = self.max_minor

        remaining_minor = self.remaining_minor

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "currency": currency,
                "maxMinor": max_minor,
                "remainingMinor": remaining_minor,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        currency = d.pop("currency")

        max_minor = d.pop("maxMinor")

        remaining_minor = d.pop("remainingMinor")

        mandate_budget = cls(
            currency=currency,
            max_minor=max_minor,
            remaining_minor=remaining_minor,
        )

        mandate_budget.additional_properties = d
        return mandate_budget

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
