from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.trust_grade_evidence_incidents import TrustGradeEvidenceIncidents


T = TypeVar("T", bound="TrustGradeEvidence")


@_attrs_define
class TrustGradeEvidence:
    """
    Attributes:
        coverages (int):
        incidents (TrustGradeEvidenceIncidents): Verdicts with the operator at fault: what the grade counts.
    """

    coverages: int
    incidents: TrustGradeEvidenceIncidents
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        coverages = self.coverages

        incidents = self.incidents.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "coverages": coverages,
                "incidents": incidents,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.trust_grade_evidence_incidents import TrustGradeEvidenceIncidents

        d = dict(src_dict)
        coverages = d.pop("coverages")

        incidents = TrustGradeEvidenceIncidents.from_dict(d.pop("incidents"))

        trust_grade_evidence = cls(
            coverages=coverages,
            incidents=incidents,
        )

        trust_grade_evidence.additional_properties = d
        return trust_grade_evidence

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
