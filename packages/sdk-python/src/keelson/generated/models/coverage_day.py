from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="CoverageDay")


@_attrs_define
class CoverageDay:
    """
    Attributes:
        day (datetime.date):
        coverages (int):
        covered (float): US dollars.
        premiums (float): US dollars.
        incidents (int): Verdicts with the operator at fault on that day's coverages.
    """

    day: datetime.date
    coverages: int
    covered: float
    premiums: float
    incidents: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        day = self.day.isoformat()

        coverages = self.coverages

        covered = self.covered

        premiums = self.premiums

        incidents = self.incidents

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "day": day,
                "coverages": coverages,
                "covered": covered,
                "premiums": premiums,
                "incidents": incidents,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        day = datetime.date.fromisoformat(d.pop("day"))

        coverages = d.pop("coverages")

        covered = d.pop("covered")

        premiums = d.pop("premiums")

        incidents = d.pop("incidents")

        coverage_day = cls(
            day=day,
            coverages=coverages,
            covered=covered,
            premiums=premiums,
            incidents=incidents,
        )

        coverage_day.additional_properties = d
        return coverage_day

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
