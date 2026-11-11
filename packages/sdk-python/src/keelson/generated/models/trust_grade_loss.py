from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="TrustGradeLoss")


@_attrs_define
class TrustGradeLoss:
    """
    Attributes:
        horizon (int):
        scenarios (int):
        expected_minor (int):
        var_99_minor (int):
        es_99_minor (int):
        var_995_minor (int):
    """

    horizon: int
    scenarios: int
    expected_minor: int
    var_99_minor: int
    es_99_minor: int
    var_995_minor: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        horizon = self.horizon

        scenarios = self.scenarios

        expected_minor = self.expected_minor

        var_99_minor = self.var_99_minor

        es_99_minor = self.es_99_minor

        var_995_minor = self.var_995_minor

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "horizon": horizon,
                "scenarios": scenarios,
                "expectedMinor": expected_minor,
                "var99Minor": var_99_minor,
                "es99Minor": es_99_minor,
                "var995Minor": var_995_minor,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        horizon = d.pop("horizon")

        scenarios = d.pop("scenarios")

        expected_minor = d.pop("expectedMinor")

        var_99_minor = d.pop("var99Minor")

        es_99_minor = d.pop("es99Minor")

        var_995_minor = d.pop("var995Minor")

        trust_grade_loss = cls(
            horizon=horizon,
            scenarios=scenarios,
            expected_minor=expected_minor,
            var_99_minor=var_99_minor,
            es_99_minor=es_99_minor,
            var_995_minor=var_995_minor,
        )

        trust_grade_loss.additional_properties = d
        return trust_grade_loss

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
