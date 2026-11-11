from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="DisputeStatusVerdictSignaturesItem")


@_attrs_define
class DisputeStatusVerdictSignaturesItem:
    """
    Attributes:
        tee (int):
        signer (str):
        signature (str):
    """

    tee: int
    signer: str
    signature: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        tee = self.tee

        signer = self.signer

        signature = self.signature

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "tee": tee,
                "signer": signer,
                "signature": signature,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        tee = d.pop("tee")

        signer = d.pop("signer")

        signature = d.pop("signature")

        dispute_status_verdict_signatures_item = cls(
            tee=tee,
            signer=signer,
            signature=signature,
        )

        dispute_status_verdict_signatures_item.additional_properties = d
        return dispute_status_verdict_signatures_item

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
