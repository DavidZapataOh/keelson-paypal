from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="TrustGradePremium")


@_attrs_define
class TrustGradePremium:
    """
    Attributes:
        bps (int): Charged on each new coverage, in `lockCoverage`.
        model_bps (int):
        floor_bps (int):
        theta (float):
        cost_of_capital (float):
    """

    bps: int
    model_bps: int
    floor_bps: int
    theta: float
    cost_of_capital: float
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        bps = self.bps

        model_bps = self.model_bps

        floor_bps = self.floor_bps

        theta = self.theta

        cost_of_capital = self.cost_of_capital

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "bps": bps,
                "modelBps": model_bps,
                "floorBps": floor_bps,
                "theta": theta,
                "costOfCapital": cost_of_capital,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        bps = d.pop("bps")

        model_bps = d.pop("modelBps")

        floor_bps = d.pop("floorBps")

        theta = d.pop("theta")

        cost_of_capital = d.pop("costOfCapital")

        trust_grade_premium = cls(
            bps=bps,
            model_bps=model_bps,
            floor_bps=floor_bps,
            theta=theta,
            cost_of_capital=cost_of_capital,
        )

        trust_grade_premium.additional_properties = d
        return trust_grade_premium

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
