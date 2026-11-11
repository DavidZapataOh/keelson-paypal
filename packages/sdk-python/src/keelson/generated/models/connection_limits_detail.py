from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.connection_limits_detail_merchants_item import ConnectionLimitsDetailMerchantsItem


T = TypeVar("T", bound="ConnectionLimitsDetail")


@_attrs_define
class ConnectionLimitsDetail:
    """
    Attributes:
        currency (str):
        per_purchase_minor (str):
        total_minor (str):
        ask_above_minor (None | str):
        merchants (list[ConnectionLimitsDetailMerchantsItem]):
        until (str):
    """

    currency: str
    per_purchase_minor: str
    total_minor: str
    ask_above_minor: str | None
    merchants: list[ConnectionLimitsDetailMerchantsItem]
    until: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        currency = self.currency

        per_purchase_minor = self.per_purchase_minor

        total_minor = self.total_minor

        ask_above_minor: str | None
        ask_above_minor = self.ask_above_minor

        merchants = []
        for merchants_item_data in self.merchants:
            merchants_item = merchants_item_data.to_dict()
            merchants.append(merchants_item)

        until = self.until

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "currency": currency,
                "perPurchaseMinor": per_purchase_minor,
                "totalMinor": total_minor,
                "askAboveMinor": ask_above_minor,
                "merchants": merchants,
                "until": until,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.connection_limits_detail_merchants_item import (
            ConnectionLimitsDetailMerchantsItem,
        )

        d = dict(src_dict)
        currency = d.pop("currency")

        per_purchase_minor = d.pop("perPurchaseMinor")

        total_minor = d.pop("totalMinor")

        def _parse_ask_above_minor(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        ask_above_minor = _parse_ask_above_minor(d.pop("askAboveMinor"))

        merchants = []
        _merchants = d.pop("merchants")
        for merchants_item_data in _merchants:
            merchants_item = ConnectionLimitsDetailMerchantsItem.from_dict(merchants_item_data)

            merchants.append(merchants_item)

        until = d.pop("until")

        connection_limits_detail = cls(
            currency=currency,
            per_purchase_minor=per_purchase_minor,
            total_minor=total_minor,
            ask_above_minor=ask_above_minor,
            merchants=merchants,
            until=until,
        )

        connection_limits_detail.additional_properties = d
        return connection_limits_detail

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
