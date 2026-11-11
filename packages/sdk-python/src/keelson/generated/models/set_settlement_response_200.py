from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.set_settlement_response_200_rail import (
    SetSettlementResponse200Rail,
    check_set_settlement_response_200_rail,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="SetSettlementResponse200")


@_attrs_define
class SetSettlementResponse200:
    """
    Attributes:
        rail (SetSettlementResponse200Rail): `pyusd`: slashes and warranties pay the merchant in PYUSD on chain.
            `paypal`: they pay Keelson's treasury, and Keelson sends the merchant a PayPal Payout in USD.
        paypal_receiver (str | Unset): The PayPal account paid: an email address or a PayPal account id.
    """

    rail: SetSettlementResponse200Rail
    paypal_receiver: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        rail: str = self.rail

        paypal_receiver: str | Unset
        if isinstance(self.paypal_receiver, Unset):
            paypal_receiver = UNSET
        else:
            paypal_receiver = self.paypal_receiver

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "rail": rail,
            }
        )
        if paypal_receiver is not UNSET:
            field_dict["paypal_receiver"] = paypal_receiver

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        rail = check_set_settlement_response_200_rail(d.pop("rail"))

        def _parse_paypal_receiver(data: object) -> str | Unset:
            if isinstance(data, Unset):
                return data
            return cast(str | Unset, data)

        paypal_receiver = _parse_paypal_receiver(d.pop("paypal_receiver", UNSET))

        set_settlement_response_200 = cls(
            rail=rail,
            paypal_receiver=paypal_receiver,
        )

        set_settlement_response_200.additional_properties = d
        return set_settlement_response_200

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
