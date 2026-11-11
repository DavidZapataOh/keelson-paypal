from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="TrustGradeEvidenceIncidents")


@_attrs_define
class TrustGradeEvidenceIncidents:
    """Verdicts with the operator at fault: what the grade counts.

    Attributes:
        total (int):
        slashes (int): Paid from the operator's bond.
        pool (int): Paid from its `ViolationBondPool` deposit.
        uncollected (int): Paid by Keelson's treasury instead.
        pending (int): Not settled yet.
    """

    total: int
    slashes: int
    pool: int
    uncollected: int
    pending: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        total = self.total

        slashes = self.slashes

        pool = self.pool

        uncollected = self.uncollected

        pending = self.pending

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "total": total,
                "slashes": slashes,
                "pool": pool,
                "uncollected": uncollected,
                "pending": pending,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        total = d.pop("total")

        slashes = d.pop("slashes")

        pool = d.pop("pool")

        uncollected = d.pop("uncollected")

        pending = d.pop("pending")

        trust_grade_evidence_incidents = cls(
            total=total,
            slashes=slashes,
            pool=pool,
            uncollected=uncollected,
            pending=pending,
        )

        trust_grade_evidence_incidents.additional_properties = d
        return trust_grade_evidence_incidents

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
