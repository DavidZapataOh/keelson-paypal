from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="ListTeeAttestationsResponse200Measurements")


@_attrs_define
class ListTeeAttestationsResponse200Measurements:
    """
    Attributes:
        engine_build_id (str):
        tdx (list[str]):
        nitro (list[str]):
        provenance (str): Where the Sigstore build provenance attested measurements.json is published; `gh attestation
            verify` checks it.
    """

    engine_build_id: str
    tdx: list[str]
    nitro: list[str]
    provenance: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        engine_build_id = self.engine_build_id

        tdx = self.tdx

        nitro = self.nitro

        provenance = self.provenance

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "engineBuildId": engine_build_id,
                "tdx": tdx,
                "nitro": nitro,
                "provenance": provenance,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        engine_build_id = d.pop("engineBuildId")

        tdx = cast(list[str], d.pop("tdx"))

        nitro = cast(list[str], d.pop("nitro"))

        provenance = d.pop("provenance")

        list_tee_attestations_response_200_measurements = cls(
            engine_build_id=engine_build_id,
            tdx=tdx,
            nitro=nitro,
            provenance=provenance,
        )

        list_tee_attestations_response_200_measurements.additional_properties = d
        return list_tee_attestations_response_200_measurements

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
