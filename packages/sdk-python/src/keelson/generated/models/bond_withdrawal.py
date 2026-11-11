from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.bond_withdrawal_chain_id_type_0 import (
    BondWithdrawalChainIdType0,
    check_bond_withdrawal_chain_id_type_0,
)
from ..models.bond_withdrawal_chain_id_type_1 import (
    BondWithdrawalChainIdType1,
    check_bond_withdrawal_chain_id_type_1,
)

T = TypeVar("T", bound="BondWithdrawal")


@_attrs_define
class BondWithdrawal:
    """
    Attributes:
        chain_id (BondWithdrawalChainIdType0 | BondWithdrawalChainIdType1): Arbitrum Sepolia (421614) or Arbitrum One
            (42161).
        amount (str): PYUSD base units.
        to (str):
        nonce (str): `vault.nonces(signer)`.
        deadline (str): Unix seconds.
        owner_signature (str): The vault's EIP-712 `WithdrawalRequest`, by the agent's owner or agent wallet.
    """

    chain_id: BondWithdrawalChainIdType0 | BondWithdrawalChainIdType1
    amount: str
    to: str
    nonce: str
    deadline: str
    owner_signature: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        chain_id: int
        if isinstance(self.chain_id, int):
            chain_id = self.chain_id
        else:
            chain_id = self.chain_id

        amount = self.amount

        to = self.to

        nonce = self.nonce

        deadline = self.deadline

        owner_signature = self.owner_signature

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chainId": chain_id,
                "amount": amount,
                "to": to,
                "nonce": nonce,
                "deadline": deadline,
                "ownerSignature": owner_signature,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)

        def _parse_chain_id(
            data: object,
        ) -> BondWithdrawalChainIdType0 | BondWithdrawalChainIdType1:
            try:
                if not isinstance(data, int):
                    raise TypeError()
                chain_id_type_0 = check_bond_withdrawal_chain_id_type_0(data)

                return chain_id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, int):
                raise TypeError()
            chain_id_type_1 = check_bond_withdrawal_chain_id_type_1(data)

            return chain_id_type_1

        chain_id = _parse_chain_id(d.pop("chainId"))

        amount = d.pop("amount")

        to = d.pop("to")

        nonce = d.pop("nonce")

        deadline = d.pop("deadline")

        owner_signature = d.pop("ownerSignature")

        bond_withdrawal = cls(
            chain_id=chain_id,
            amount=amount,
            to=to,
            nonce=nonce,
            deadline=deadline,
            owner_signature=owner_signature,
        )

        bond_withdrawal.additional_properties = d
        return bond_withdrawal

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
