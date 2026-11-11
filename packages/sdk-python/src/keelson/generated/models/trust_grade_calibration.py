from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="TrustGradeCalibration")


@_attrs_define
class TrustGradeCalibration:
    """
    Attributes:
        id (str):
        at (datetime.datetime):
        campaigns (list[str]): The red-team campaigns pooled.
        mu_ppm (int): The prior's mean, ASR × escape + amber.
        kappa (float): The prior's strength, by the method of moments.
    """

    id: str
    at: datetime.datetime
    campaigns: list[str]
    mu_ppm: int
    kappa: float
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        at = self.at.isoformat()

        campaigns = self.campaigns

        mu_ppm = self.mu_ppm

        kappa = self.kappa

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "at": at,
                "campaigns": campaigns,
                "mu_ppm": mu_ppm,
                "kappa": kappa,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        at = datetime.datetime.fromisoformat(d.pop("at"))

        campaigns = cast(list[str], d.pop("campaigns"))

        mu_ppm = d.pop("mu_ppm")

        kappa = d.pop("kappa")

        trust_grade_calibration = cls(
            id=id,
            at=at,
            campaigns=campaigns,
            mu_ppm=mu_ppm,
            kappa=kappa,
        )

        trust_grade_calibration.additional_properties = d
        return trust_grade_calibration

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
