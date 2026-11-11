from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="TrustGradeFrequency")


@_attrs_define
class TrustGradeFrequency:
    """
    Attributes:
        alpha (float):
        beta (float):
        credibility_ppm (int):
        mean_ppm (int):
        upper95_ppm (int):
    """

    alpha: float
    beta: float
    credibility_ppm: int
    mean_ppm: int
    upper95_ppm: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        alpha = self.alpha

        beta = self.beta

        credibility_ppm = self.credibility_ppm

        mean_ppm = self.mean_ppm

        upper95_ppm = self.upper95_ppm

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "alpha": alpha,
                "beta": beta,
                "credibility_ppm": credibility_ppm,
                "mean_ppm": mean_ppm,
                "upper95_ppm": upper95_ppm,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        alpha = d.pop("alpha")

        beta = d.pop("beta")

        credibility_ppm = d.pop("credibility_ppm")

        mean_ppm = d.pop("mean_ppm")

        upper95_ppm = d.pop("upper95_ppm")

        trust_grade_frequency = cls(
            alpha=alpha,
            beta=beta,
            credibility_ppm=credibility_ppm,
            mean_ppm=mean_ppm,
            upper95_ppm=upper95_ppm,
        )

        trust_grade_frequency.additional_properties = d
        return trust_grade_frequency

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
