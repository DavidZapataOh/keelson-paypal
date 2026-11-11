from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="PendingPurchaseHold")


@_attrs_define
class PendingPurchaseHold:
    """
    Attributes:
        request_id (str):
        order_id (str): The PayPal order the buyer approves.
        merchant (str):
        amount_minor (str):
    """

    request_id: str
    order_id: str
    merchant: str
    amount_minor: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        request_id = self.request_id

        order_id = self.order_id

        merchant = self.merchant

        amount_minor = self.amount_minor

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "requestId": request_id,
                "orderId": order_id,
                "merchant": merchant,
                "amountMinor": amount_minor,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        request_id = d.pop("requestId")

        order_id = d.pop("orderId")

        merchant = d.pop("merchant")

        amount_minor = d.pop("amountMinor")

        pending_purchase_hold = cls(
            request_id=request_id,
            order_id=order_id,
            merchant=merchant,
            amount_minor=amount_minor,
        )

        pending_purchase_hold.additional_properties = d
        return pending_purchase_hold

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
