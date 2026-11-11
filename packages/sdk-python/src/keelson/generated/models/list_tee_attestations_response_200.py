from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.list_tee_attestations_response_200_measurements import (
        ListTeeAttestationsResponse200Measurements,
    )
    from ..models.tee_leg import TeeLeg


T = TypeVar("T", bound="ListTeeAttestationsResponse200")


@_attrs_define
class ListTeeAttestationsResponse200:
    """
    Attributes:
        legs (list[TeeLeg]):
        measurements (ListTeeAttestationsResponse200Measurements):
    """

    legs: list[TeeLeg]
    measurements: ListTeeAttestationsResponse200Measurements
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        legs = []
        for legs_item_data in self.legs:
            legs_item = legs_item_data.to_dict()
            legs.append(legs_item)

        measurements = self.measurements.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "legs": legs,
                "measurements": measurements,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.list_tee_attestations_response_200_measurements import (
            ListTeeAttestationsResponse200Measurements,
        )
        from ..models.tee_leg import TeeLeg

        d = dict(src_dict)
        legs = []
        _legs = d.pop("legs")
        for legs_item_data in _legs:
            legs_item = TeeLeg.from_dict(legs_item_data)

            legs.append(legs_item)

        measurements = ListTeeAttestationsResponse200Measurements.from_dict(d.pop("measurements"))

        list_tee_attestations_response_200 = cls(
            legs=legs,
            measurements=measurements,
        )

        list_tee_attestations_response_200.additional_properties = d
        return list_tee_attestations_response_200

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
