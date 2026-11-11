from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="LivePurchaseCard")


@_attrs_define
class LivePurchaseCard:
    """A card purchase: the merchant as the card network named it, and how many of the card's authorizations both legs
    approved and declined.

        Attributes:
            last_four (str):
            merchant_name (None | str):
            mcc (None | str):
            approved (int):
            declined (int):
            settled_minor (None | str):
    """

    last_four: str
    merchant_name: str | None
    mcc: str | None
    approved: int
    declined: int
    settled_minor: str | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        last_four = self.last_four

        merchant_name: str | None
        merchant_name = self.merchant_name

        mcc: str | None
        mcc = self.mcc

        approved = self.approved

        declined = self.declined

        settled_minor: str | None
        settled_minor = self.settled_minor

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "lastFour": last_four,
                "merchantName": merchant_name,
                "mcc": mcc,
                "approved": approved,
                "declined": declined,
                "settledMinor": settled_minor,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        last_four = d.pop("lastFour")

        def _parse_merchant_name(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        merchant_name = _parse_merchant_name(d.pop("merchantName"))

        def _parse_mcc(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        mcc = _parse_mcc(d.pop("mcc"))

        approved = d.pop("approved")

        declined = d.pop("declined")

        def _parse_settled_minor(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        settled_minor = _parse_settled_minor(d.pop("settledMinor"))

        live_purchase_card = cls(
            last_four=last_four,
            merchant_name=merchant_name,
            mcc=mcc,
            approved=approved,
            declined=declined,
            settled_minor=settled_minor,
        )

        live_purchase_card.additional_properties = d
        return live_purchase_card

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
