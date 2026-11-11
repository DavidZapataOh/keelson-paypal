from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="MandatePurchaseCoverage")


@_attrs_define
class MandatePurchaseCoverage:
    """The `lockCoverage` transaction of the operator's bond.

    Attributes:
        chain_id (int):
        tx_hash (None | str):
    """

    chain_id: int
    tx_hash: str | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        chain_id = self.chain_id

        tx_hash: str | None
        tx_hash = self.tx_hash

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chainId": chain_id,
                "txHash": tx_hash,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        chain_id = d.pop("chainId")

        def _parse_tx_hash(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        tx_hash = _parse_tx_hash(d.pop("txHash"))

        mandate_purchase_coverage = cls(
            chain_id=chain_id,
            tx_hash=tx_hash,
        )

        mandate_purchase_coverage.additional_properties = d
        return mandate_purchase_coverage

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
