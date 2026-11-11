from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.bond_deposit_type_1_chain_id_type_0 import (
    BondDepositType1ChainIdType0,
    check_bond_deposit_type_1_chain_id_type_0,
)
from ..models.bond_deposit_type_1_chain_id_type_1 import (
    BondDepositType1ChainIdType1,
    check_bond_deposit_type_1_chain_id_type_1,
)
from ..models.bond_deposit_type_1_kind import BondDepositType1Kind, check_bond_deposit_type_1_kind

T = TypeVar("T", bound="BondDepositType1")


@_attrs_define
class BondDepositType1:
    """
    Attributes:
        chain_id (BondDepositType1ChainIdType0 | BondDepositType1ChainIdType1): Arbitrum Sepolia (421614) or Arbitrum
            One (42161).
        kind (BondDepositType1Kind):
        owner (str): The agent's owner or agent wallet.
        amount (str): PYUSD base units.
        deadline (str): Unix seconds.
        signature (str): PYUSD's EIP-2612 permit to the vault.
    """

    chain_id: BondDepositType1ChainIdType0 | BondDepositType1ChainIdType1
    kind: BondDepositType1Kind
    owner: str
    amount: str
    deadline: str
    signature: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        chain_id: int
        if isinstance(self.chain_id, int):
            chain_id = self.chain_id
        else:
            chain_id = self.chain_id

        kind: str = self.kind

        owner = self.owner

        amount = self.amount

        deadline = self.deadline

        signature = self.signature

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chainId": chain_id,
                "kind": kind,
                "owner": owner,
                "amount": amount,
                "deadline": deadline,
                "signature": signature,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)

        def _parse_chain_id(
            data: object,
        ) -> BondDepositType1ChainIdType0 | BondDepositType1ChainIdType1:
            try:
                if not isinstance(data, int):
                    raise TypeError()
                chain_id_type_0 = check_bond_deposit_type_1_chain_id_type_0(data)

                return chain_id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, int):
                raise TypeError()
            chain_id_type_1 = check_bond_deposit_type_1_chain_id_type_1(data)

            return chain_id_type_1

        chain_id = _parse_chain_id(d.pop("chainId"))

        kind = check_bond_deposit_type_1_kind(d.pop("kind"))

        owner = d.pop("owner")

        amount = d.pop("amount")

        deadline = d.pop("deadline")

        signature = d.pop("signature")

        bond_deposit_type_1 = cls(
            chain_id=chain_id,
            kind=kind,
            owner=owner,
            amount=amount,
            deadline=deadline,
            signature=signature,
        )

        bond_deposit_type_1.additional_properties = d
        return bond_deposit_type_1

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
