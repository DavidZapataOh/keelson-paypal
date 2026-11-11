from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="CreatePurchaseHold")


@_attrs_define
class CreatePurchaseHold:
    """
    Attributes:
        request_id (str): The request id the purchase is countersigned under.
        merchant (str):
        currency (str):
        amount_minor (str): The checkout total the purchase is countersigned for, tax and shipping included, in minor
            units.
        cart_hash (str):
        closed_mandate (str): The mandate's open mandate closed by the agent key over `requestId` and `cartHash`; it
            proves the caller is the mandate's agent.
    """

    request_id: str
    merchant: str
    currency: str
    amount_minor: str
    cart_hash: str
    closed_mandate: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        request_id = self.request_id

        merchant = self.merchant

        currency = self.currency

        amount_minor = self.amount_minor

        cart_hash = self.cart_hash

        closed_mandate = self.closed_mandate

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "requestId": request_id,
                "merchant": merchant,
                "currency": currency,
                "amountMinor": amount_minor,
                "cartHash": cart_hash,
                "closedMandate": closed_mandate,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        request_id = d.pop("requestId")

        merchant = d.pop("merchant")

        currency = d.pop("currency")

        amount_minor = d.pop("amountMinor")

        cart_hash = d.pop("cartHash")

        closed_mandate = d.pop("closedMandate")

        create_purchase_hold = cls(
            request_id=request_id,
            merchant=merchant,
            currency=currency,
            amount_minor=amount_minor,
            cart_hash=cart_hash,
            closed_mandate=closed_mandate,
        )

        create_purchase_hold.additional_properties = d
        return create_purchase_hold

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
