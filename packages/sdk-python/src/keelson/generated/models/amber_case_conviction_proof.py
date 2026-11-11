from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="AmberCaseConvictionProof")


@_attrs_define
class AmberCaseConvictionProof:
    """
    Attributes:
        bytes_ (int):
        hash_ (str): keccak256 of the proof.
        public_inputs (list[str]): `range_hi, range_lo, amber_commitment, product, field_id`, as the court gave the
            verifier.
    """

    bytes_: int
    hash_: str
    public_inputs: list[str]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        bytes_ = self.bytes_

        hash_ = self.hash_

        public_inputs = self.public_inputs

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "bytes": bytes_,
                "hash": hash_,
                "public_inputs": public_inputs,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        bytes_ = d.pop("bytes")

        hash_ = d.pop("hash")

        public_inputs = cast(list[str], d.pop("public_inputs"))

        amber_case_conviction_proof = cls(
            bytes_=bytes_,
            hash_=hash_,
            public_inputs=public_inputs,
        )

        amber_case_conviction_proof.additional_properties = d
        return amber_case_conviction_proof

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
