from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.connection_limits_currency import (
    ConnectionLimitsCurrency,
    check_connection_limits_currency,
)
from ..models.connection_limits_merchants_item import (
    ConnectionLimitsMerchantsItem,
    check_connection_limits_merchants_item,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="ConnectionLimits")


@_attrs_define
class ConnectionLimits:
    """
    Attributes:
        per_purchase_minor (int): Most one purchase may cost, minor units.
        total_minor (int): Most all purchases may cost together.
        until (datetime.datetime): When the mandate ends.
        currency (ConnectionLimitsCurrency | Unset):  Default: 'USD'.
        merchants (list[ConnectionLimitsMerchantsItem] | Unset): Onboarded merchant ids; every one when left out.
        ask_above_minor (int | Unset): Above this a purchase waits for the user's one-time approval, although the limits
            allow it.
    """

    per_purchase_minor: int
    total_minor: int
    until: datetime.datetime
    currency: ConnectionLimitsCurrency | Unset = "USD"
    merchants: list[ConnectionLimitsMerchantsItem] | Unset = UNSET
    ask_above_minor: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        per_purchase_minor = self.per_purchase_minor

        total_minor = self.total_minor

        until = self.until.isoformat()

        currency: str | Unset = UNSET
        if not isinstance(self.currency, Unset):
            currency = self.currency

        merchants: list[str] | Unset = UNSET
        if not isinstance(self.merchants, Unset):
            merchants = []
            for merchants_item_data in self.merchants:
                merchants_item: str = merchants_item_data
                merchants.append(merchants_item)

        ask_above_minor = self.ask_above_minor

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "perPurchaseMinor": per_purchase_minor,
                "totalMinor": total_minor,
                "until": until,
            }
        )
        if currency is not UNSET:
            field_dict["currency"] = currency
        if merchants is not UNSET:
            field_dict["merchants"] = merchants
        if ask_above_minor is not UNSET:
            field_dict["askAboveMinor"] = ask_above_minor

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        per_purchase_minor = d.pop("perPurchaseMinor")

        total_minor = d.pop("totalMinor")

        until = datetime.datetime.fromisoformat(d.pop("until"))

        _currency = d.pop("currency", UNSET)
        currency: ConnectionLimitsCurrency | Unset
        if isinstance(_currency, Unset):
            currency = UNSET
        else:
            currency = check_connection_limits_currency(_currency)

        _merchants = d.pop("merchants", UNSET)
        merchants: list[ConnectionLimitsMerchantsItem] | Unset = UNSET
        if _merchants is not UNSET:
            merchants = []
            for merchants_item_data in _merchants:
                merchants_item = check_connection_limits_merchants_item(merchants_item_data)

                merchants.append(merchants_item)

        ask_above_minor = d.pop("askAboveMinor", UNSET)

        connection_limits = cls(
            per_purchase_minor=per_purchase_minor,
            total_minor=total_minor,
            until=until,
            currency=currency,
            merchants=merchants,
            ask_above_minor=ask_above_minor,
        )

        connection_limits.additional_properties = d
        return connection_limits

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
