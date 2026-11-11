from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.purchase_card_detail_authorizations_item_legs import (
        PurchaseCardDetailAuthorizationsItemLegs,
    )


T = TypeVar("T", bound="PurchaseCardDetailAuthorizationsItem")


@_attrs_define
class PurchaseCardDetailAuthorizationsItem:
    """
    Attributes:
        id (str):
        amount_minor (str):
        currency (str):
        mcc (str):
        merchant_name (str):
        merchant_country (str):
        approved (bool):
        failed_mask (int):
        reason (None | str):
        legs (PurchaseCardDetailAuthorizationsItemLegs):
        latency_ms (int):
        at (str):
    """

    id: str
    amount_minor: str
    currency: str
    mcc: str
    merchant_name: str
    merchant_country: str
    approved: bool
    failed_mask: int
    reason: str | None
    legs: PurchaseCardDetailAuthorizationsItemLegs
    latency_ms: int
    at: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        amount_minor = self.amount_minor

        currency = self.currency

        mcc = self.mcc

        merchant_name = self.merchant_name

        merchant_country = self.merchant_country

        approved = self.approved

        failed_mask = self.failed_mask

        reason: str | None
        reason = self.reason

        legs = self.legs.to_dict()

        latency_ms = self.latency_ms

        at = self.at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "amountMinor": amount_minor,
                "currency": currency,
                "mcc": mcc,
                "merchantName": merchant_name,
                "merchantCountry": merchant_country,
                "approved": approved,
                "failedMask": failed_mask,
                "reason": reason,
                "legs": legs,
                "latencyMs": latency_ms,
                "at": at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.purchase_card_detail_authorizations_item_legs import (
            PurchaseCardDetailAuthorizationsItemLegs,
        )

        d = dict(src_dict)
        id = d.pop("id")

        amount_minor = d.pop("amountMinor")

        currency = d.pop("currency")

        mcc = d.pop("mcc")

        merchant_name = d.pop("merchantName")

        merchant_country = d.pop("merchantCountry")

        approved = d.pop("approved")

        failed_mask = d.pop("failedMask")

        def _parse_reason(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        reason = _parse_reason(d.pop("reason"))

        legs = PurchaseCardDetailAuthorizationsItemLegs.from_dict(d.pop("legs"))

        latency_ms = d.pop("latencyMs")

        at = d.pop("at")

        purchase_card_detail_authorizations_item = cls(
            id=id,
            amount_minor=amount_minor,
            currency=currency,
            mcc=mcc,
            merchant_name=merchant_name,
            merchant_country=merchant_country,
            approved=approved,
            failed_mask=failed_mask,
            reason=reason,
            legs=legs,
            latency_ms=latency_ms,
            at=at,
        )

        purchase_card_detail_authorizations_item.additional_properties = d
        return purchase_card_detail_authorizations_item

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
