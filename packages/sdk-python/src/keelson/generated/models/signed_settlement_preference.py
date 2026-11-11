from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.signed_settlement_preference_rail import (
    SignedSettlementPreferenceRail,
    check_signed_settlement_preference_rail,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="SignedSettlementPreference")


@_attrs_define
class SignedSettlementPreference:
    """
    Attributes:
        rail (SignedSettlementPreferenceRail): `pyusd`: slashes and warranties pay the merchant in PYUSD on chain.
            `paypal`: they pay Keelson's treasury, and Keelson sends the merchant a PayPal Payout in USD.
        nonce (str): Higher than the nonce of the merchant's last choice.
        deadline (str): Unix seconds after which the signature is refused.
        merchant_signature (str): The merchant's EIP-712 `SettlementPreference(string merchantId,string rail,string
            paypalReceiver,uint256 nonce,uint256 deadline)` under the bond vault's domain, by its settlement address;
            `paypalReceiver` is empty for `pyusd`.
        paypal_receiver (str | Unset): The PayPal account paid: an email address or a PayPal account id.
    """

    rail: SignedSettlementPreferenceRail
    nonce: str
    deadline: str
    merchant_signature: str
    paypal_receiver: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        rail: str = self.rail

        nonce = self.nonce

        deadline = self.deadline

        merchant_signature = self.merchant_signature

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
                "nonce": nonce,
                "deadline": deadline,
                "merchant_signature": merchant_signature,
            }
        )
        if paypal_receiver is not UNSET:
            field_dict["paypal_receiver"] = paypal_receiver

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        rail = check_signed_settlement_preference_rail(d.pop("rail"))

        nonce = d.pop("nonce")

        deadline = d.pop("deadline")

        merchant_signature = d.pop("merchant_signature")

        def _parse_paypal_receiver(data: object) -> str | Unset:
            if isinstance(data, Unset):
                return data
            return cast(str | Unset, data)

        paypal_receiver = _parse_paypal_receiver(d.pop("paypal_receiver", UNSET))

        signed_settlement_preference = cls(
            rail=rail,
            nonce=nonce,
            deadline=deadline,
            merchant_signature=merchant_signature,
            paypal_receiver=paypal_receiver,
        )

        signed_settlement_preference.additional_properties = d
        return signed_settlement_preference

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
