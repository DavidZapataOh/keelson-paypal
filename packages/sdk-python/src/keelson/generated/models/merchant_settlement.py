from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.merchant_settlement_rail import MerchantSettlementRail, check_merchant_settlement_rail

T = TypeVar("T", bound="MerchantSettlement")


@_attrs_define
class MerchantSettlement:
    """
    Attributes:
        rail (MerchantSettlementRail):
        paypal_receiver (None | str):
        nonce (str): The nonce of the last signed choice; 0 if none.
        updated_at (datetime.datetime | None):
    """

    rail: MerchantSettlementRail
    paypal_receiver: str | None
    nonce: str
    updated_at: datetime.datetime | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        rail: str = self.rail

        paypal_receiver: str | None
        paypal_receiver = self.paypal_receiver

        nonce = self.nonce

        updated_at: str | None
        if isinstance(self.updated_at, datetime.datetime):
            updated_at = self.updated_at.isoformat()
        else:
            updated_at = self.updated_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "rail": rail,
                "paypal_receiver": paypal_receiver,
                "nonce": nonce,
                "updated_at": updated_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        rail = check_merchant_settlement_rail(d.pop("rail"))

        def _parse_paypal_receiver(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        paypal_receiver = _parse_paypal_receiver(d.pop("paypal_receiver"))

        nonce = d.pop("nonce")

        def _parse_updated_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                updated_at_type_0 = datetime.datetime.fromisoformat(data)

                return updated_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        updated_at = _parse_updated_at(d.pop("updated_at"))

        merchant_settlement = cls(
            rail=rail,
            paypal_receiver=paypal_receiver,
            nonce=nonce,
            updated_at=updated_at,
        )

        merchant_settlement.additional_properties = d
        return merchant_settlement

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
