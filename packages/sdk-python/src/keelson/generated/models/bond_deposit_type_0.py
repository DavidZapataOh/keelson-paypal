from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.bond_deposit_type_0_chain_id_type_0 import (
    BondDepositType0ChainIdType0,
    check_bond_deposit_type_0_chain_id_type_0,
)
from ..models.bond_deposit_type_0_chain_id_type_1 import (
    BondDepositType0ChainIdType1,
    check_bond_deposit_type_0_chain_id_type_1,
)
from ..models.bond_deposit_type_0_kind import BondDepositType0Kind, check_bond_deposit_type_0_kind

T = TypeVar("T", bound="BondDepositType0")


@_attrs_define
class BondDepositType0:
    """
    Attributes:
        chain_id (BondDepositType0ChainIdType0 | BondDepositType0ChainIdType1): Arbitrum Sepolia (421614) or Arbitrum
            One (42161).
        kind (BondDepositType0Kind):
        from_ (str):
        amount (str): PYUSD base units.
        valid_after (str): Unix seconds.
        valid_before (str): Unix seconds.
        salt (str): The EIP-3009 nonce is `keccak256(abi.encode(agentId, salt))`, so the authorization credits only this
            agent.
        signature (str): PYUSD's EIP-3009 `ReceiveWithAuthorization` to the vault, signed by `from`.
    """

    chain_id: BondDepositType0ChainIdType0 | BondDepositType0ChainIdType1
    kind: BondDepositType0Kind
    from_: str
    amount: str
    valid_after: str
    valid_before: str
    salt: str
    signature: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        chain_id: int
        if isinstance(self.chain_id, int):
            chain_id = self.chain_id
        else:
            chain_id = self.chain_id

        kind: str = self.kind

        from_ = self.from_

        amount = self.amount

        valid_after = self.valid_after

        valid_before = self.valid_before

        salt = self.salt

        signature = self.signature

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chainId": chain_id,
                "kind": kind,
                "from": from_,
                "amount": amount,
                "validAfter": valid_after,
                "validBefore": valid_before,
                "salt": salt,
                "signature": signature,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)

        def _parse_chain_id(
            data: object,
        ) -> BondDepositType0ChainIdType0 | BondDepositType0ChainIdType1:
            try:
                if not isinstance(data, int):
                    raise TypeError()
                chain_id_type_0 = check_bond_deposit_type_0_chain_id_type_0(data)

                return chain_id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, int):
                raise TypeError()
            chain_id_type_1 = check_bond_deposit_type_0_chain_id_type_1(data)

            return chain_id_type_1

        chain_id = _parse_chain_id(d.pop("chainId"))

        kind = check_bond_deposit_type_0_kind(d.pop("kind"))

        from_ = d.pop("from")

        amount = d.pop("amount")

        valid_after = d.pop("validAfter")

        valid_before = d.pop("validBefore")

        salt = d.pop("salt")

        signature = d.pop("signature")

        bond_deposit_type_0 = cls(
            chain_id=chain_id,
            kind=kind,
            from_=from_,
            amount=amount,
            valid_after=valid_after,
            valid_before=valid_before,
            salt=salt,
            signature=signature,
        )

        bond_deposit_type_0.additional_properties = d
        return bond_deposit_type_0

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
