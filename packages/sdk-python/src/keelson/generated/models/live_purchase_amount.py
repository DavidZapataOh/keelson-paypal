from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.checkout_breakdown import CheckoutBreakdown


T = TypeVar("T", bound="LivePurchaseAmount")


@_attrs_define
class LivePurchaseAmount:
    """
    Attributes:
        currency (str):
        minor (str):
        breakdown (CheckoutBreakdown | Unset): What the countersigned total is made of, in minor units: the items, plus
            tax and shipping, less discounts. Absent for purchases countersigned without it.
    """

    currency: str
    minor: str
    breakdown: CheckoutBreakdown | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        currency = self.currency

        minor = self.minor

        breakdown: dict[str, Any] | Unset = UNSET
        if not isinstance(self.breakdown, Unset):
            breakdown = self.breakdown.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "currency": currency,
                "minor": minor,
            }
        )
        if breakdown is not UNSET:
            field_dict["breakdown"] = breakdown

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.checkout_breakdown import CheckoutBreakdown

        d = dict(src_dict)
        currency = d.pop("currency")

        minor = d.pop("minor")

        _breakdown = d.pop("breakdown", UNSET)
        breakdown: CheckoutBreakdown | Unset
        if isinstance(_breakdown, Unset):
            breakdown = UNSET
        else:
            breakdown = CheckoutBreakdown.from_dict(_breakdown)

        live_purchase_amount = cls(
            currency=currency,
            minor=minor,
            breakdown=breakdown,
        )

        live_purchase_amount.additional_properties = d
        return live_purchase_amount

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
