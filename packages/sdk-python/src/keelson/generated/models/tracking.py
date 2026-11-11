from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="Tracking")


@_attrs_define
class Tracking:
    """
    Attributes:
        carrier (str): PayPal's carrier code. Example: USPS.
        tracking_number (str):
        delivered (bool | Unset): The carrier confirmed delivery; it becomes the dispute's delivery proof. Default:
            False.
    """

    carrier: str
    tracking_number: str
    delivered: bool | Unset = False
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        carrier = self.carrier

        tracking_number = self.tracking_number

        delivered = self.delivered

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "carrier": carrier,
                "tracking_number": tracking_number,
            }
        )
        if delivered is not UNSET:
            field_dict["delivered"] = delivered

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        carrier = d.pop("carrier")

        tracking_number = d.pop("tracking_number")

        delivered = d.pop("delivered", UNSET)

        tracking = cls(
            carrier=carrier,
            tracking_number=tracking_number,
            delivered=delivered,
        )

        tracking.additional_properties = d
        return tracking

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
