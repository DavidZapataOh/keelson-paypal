from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.payout_address_chain_id_type_0 import (
    PayoutAddressChainIdType0,
    check_payout_address_chain_id_type_0,
)
from ..models.payout_address_chain_id_type_1 import (
    PayoutAddressChainIdType1,
    check_payout_address_chain_id_type_1,
)

T = TypeVar("T", bound="PayoutAddress")


@_attrs_define
class PayoutAddress:
    """
    Attributes:
        chain_id (PayoutAddressChainIdType0 | PayoutAddressChainIdType1):
        merchant (str):
        payout (str): Where slashes and warranties for the merchant are paid.
        nonce (str): `vault.nonces(merchant)`.
        deadline (str): Unix seconds.
        merchant_signature (str): The vault's EIP-712 `PayoutAddress`, by the merchant (EOA or ERC-1271).
    """

    chain_id: PayoutAddressChainIdType0 | PayoutAddressChainIdType1
    merchant: str
    payout: str
    nonce: str
    deadline: str
    merchant_signature: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        chain_id: int
        if isinstance(self.chain_id, int):
            chain_id = self.chain_id
        else:
            chain_id = self.chain_id

        merchant = self.merchant

        payout = self.payout

        nonce = self.nonce

        deadline = self.deadline

        merchant_signature = self.merchant_signature

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chainId": chain_id,
                "merchant": merchant,
                "payout": payout,
                "nonce": nonce,
                "deadline": deadline,
                "merchantSignature": merchant_signature,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)

        def _parse_chain_id(data: object) -> PayoutAddressChainIdType0 | PayoutAddressChainIdType1:
            try:
                if not isinstance(data, int):
                    raise TypeError()
                chain_id_type_0 = check_payout_address_chain_id_type_0(data)

                return chain_id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, int):
                raise TypeError()
            chain_id_type_1 = check_payout_address_chain_id_type_1(data)

            return chain_id_type_1

        chain_id = _parse_chain_id(d.pop("chainId"))

        merchant = d.pop("merchant")

        payout = d.pop("payout")

        nonce = d.pop("nonce")

        deadline = d.pop("deadline")

        merchant_signature = d.pop("merchantSignature")

        payout_address = cls(
            chain_id=chain_id,
            merchant=merchant,
            payout=payout,
            nonce=nonce,
            deadline=deadline,
            merchant_signature=merchant_signature,
        )

        payout_address.additional_properties = d
        return payout_address

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
