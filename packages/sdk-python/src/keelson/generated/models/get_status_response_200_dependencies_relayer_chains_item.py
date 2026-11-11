from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.get_status_response_200_dependencies_relayer_chains_item_status import (
    GetStatusResponse200DependenciesRelayerChainsItemStatus,
    check_get_status_response_200_dependencies_relayer_chains_item_status,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="GetStatusResponse200DependenciesRelayerChainsItem")


@_attrs_define
class GetStatusResponse200DependenciesRelayerChainsItem:
    """
    Attributes:
        chain_id (int):
        status (GetStatusResponse200DependenciesRelayerChainsItemStatus):
        address (str):
        pending (int):
        balance_wei (str | Unset):
        next_nonce (str | Unset):
        base_fee_wei (str | Unset):
    """

    chain_id: int
    status: GetStatusResponse200DependenciesRelayerChainsItemStatus
    address: str
    pending: int
    balance_wei: str | Unset = UNSET
    next_nonce: str | Unset = UNSET
    base_fee_wei: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        chain_id = self.chain_id

        status: str = self.status

        address = self.address

        pending = self.pending

        balance_wei = self.balance_wei

        next_nonce = self.next_nonce

        base_fee_wei = self.base_fee_wei

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chainId": chain_id,
                "status": status,
                "address": address,
                "pending": pending,
            }
        )
        if balance_wei is not UNSET:
            field_dict["balanceWei"] = balance_wei
        if next_nonce is not UNSET:
            field_dict["nextNonce"] = next_nonce
        if base_fee_wei is not UNSET:
            field_dict["baseFeeWei"] = base_fee_wei

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        chain_id = d.pop("chainId")

        status = check_get_status_response_200_dependencies_relayer_chains_item_status(
            d.pop("status")
        )

        address = d.pop("address")

        pending = d.pop("pending")

        balance_wei = d.pop("balanceWei", UNSET)

        next_nonce = d.pop("nextNonce", UNSET)

        base_fee_wei = d.pop("baseFeeWei", UNSET)

        get_status_response_200_dependencies_relayer_chains_item = cls(
            chain_id=chain_id,
            status=status,
            address=address,
            pending=pending,
            balance_wei=balance_wei,
            next_nonce=next_nonce,
            base_fee_wei=base_fee_wei,
        )

        get_status_response_200_dependencies_relayer_chains_item.additional_properties = d
        return get_status_response_200_dependencies_relayer_chains_item

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
