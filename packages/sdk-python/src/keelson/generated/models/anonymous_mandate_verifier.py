from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="AnonymousMandateVerifier")


@_attrs_define
class AnonymousMandateVerifier:
    """The deployed verifier that accepts the proof in an `eth_call`. It checks the proof only: `public_inputs` must also
    be the countersign's `C_m` and `M`, Keelson's RP ID hash, and a root published in `RegisteredUserSet`, whose
    `verify` checks all of it.

        Attributes:
            chain_id (int):
            address (str):
    """

    chain_id: int
    address: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        chain_id = self.chain_id

        address = self.address

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chain_id": chain_id,
                "address": address,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        chain_id = d.pop("chain_id")

        address = d.pop("address")

        anonymous_mandate_verifier = cls(
            chain_id=chain_id,
            address=address,
        )

        anonymous_mandate_verifier.additional_properties = d
        return anonymous_mandate_verifier

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
