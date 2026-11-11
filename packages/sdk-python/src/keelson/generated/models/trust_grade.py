from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.trust_grade_grade import TrustGradeGrade, check_trust_grade_grade
from ..models.trust_grade_v import TrustGradeV, check_trust_grade_v

if TYPE_CHECKING:
    from ..models.trust_grade_bond import TrustGradeBond
    from ..models.trust_grade_calibration import TrustGradeCalibration
    from ..models.trust_grade_evidence import TrustGradeEvidence
    from ..models.trust_grade_frequency import TrustGradeFrequency
    from ..models.trust_grade_loss import TrustGradeLoss
    from ..models.trust_grade_premium import TrustGradePremium
    from ..models.trust_grade_reserve import TrustGradeReserve
    from ..models.trust_grade_severity import TrustGradeSeverity


T = TypeVar("T", bound="TrustGrade")


@_attrs_define
class TrustGrade:
    """An operator's trust grade, premium and minimum bond. Amounts are US cents. The red-team campaigns set the prior of
    the incident rate; the operator's covered purchases and the verdicts with it at fault update it in closed form; a
    seeded Monte Carlo of the aggregate loss over the next 30 days prices the premium and the bond.

        Attributes:
            v (TrustGradeV):
            agent_id (str):
            grade (TrustGradeGrade): From the one-sided 95 % credible upper bound of the incident rate: A ≤ 1 %, B ≤ 2 %, C
                ≤ 5 %, D ≤ 10 %, F above.
            computed_at (datetime.datetime):
            calibration (TrustGradeCalibration):
            evidence (TrustGradeEvidence):
            reserve (TrustGradeReserve): Keelson's own faults on the operator's coverages, paid by its reserve. Not in the
                grade.
            frequency (TrustGradeFrequency):
            severity (TrustGradeSeverity):
            loss (TrustGradeLoss):
            premium (TrustGradePremium):
            bond (TrustGradeBond):
            compute_ms (float):
    """

    v: TrustGradeV
    agent_id: str
    grade: TrustGradeGrade
    computed_at: datetime.datetime
    calibration: TrustGradeCalibration
    evidence: TrustGradeEvidence
    reserve: TrustGradeReserve
    frequency: TrustGradeFrequency
    severity: TrustGradeSeverity
    loss: TrustGradeLoss
    premium: TrustGradePremium
    bond: TrustGradeBond
    compute_ms: float
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        v: str = self.v

        agent_id = self.agent_id

        grade: str = self.grade

        computed_at = self.computed_at.isoformat()

        calibration = self.calibration.to_dict()

        evidence = self.evidence.to_dict()

        reserve = self.reserve.to_dict()

        frequency = self.frequency.to_dict()

        severity = self.severity.to_dict()

        loss = self.loss.to_dict()

        premium = self.premium.to_dict()

        bond = self.bond.to_dict()

        compute_ms = self.compute_ms

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "v": v,
                "agentId": agent_id,
                "grade": grade,
                "computedAt": computed_at,
                "calibration": calibration,
                "evidence": evidence,
                "reserve": reserve,
                "frequency": frequency,
                "severity": severity,
                "loss": loss,
                "premium": premium,
                "bond": bond,
                "computeMs": compute_ms,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.trust_grade_bond import TrustGradeBond
        from ..models.trust_grade_calibration import TrustGradeCalibration
        from ..models.trust_grade_evidence import TrustGradeEvidence
        from ..models.trust_grade_frequency import TrustGradeFrequency
        from ..models.trust_grade_loss import TrustGradeLoss
        from ..models.trust_grade_premium import TrustGradePremium
        from ..models.trust_grade_reserve import TrustGradeReserve
        from ..models.trust_grade_severity import TrustGradeSeverity

        d = dict(src_dict)
        v = check_trust_grade_v(d.pop("v"))

        agent_id = d.pop("agentId")

        grade = check_trust_grade_grade(d.pop("grade"))

        computed_at = datetime.datetime.fromisoformat(d.pop("computedAt"))

        calibration = TrustGradeCalibration.from_dict(d.pop("calibration"))

        evidence = TrustGradeEvidence.from_dict(d.pop("evidence"))

        reserve = TrustGradeReserve.from_dict(d.pop("reserve"))

        frequency = TrustGradeFrequency.from_dict(d.pop("frequency"))

        severity = TrustGradeSeverity.from_dict(d.pop("severity"))

        loss = TrustGradeLoss.from_dict(d.pop("loss"))

        premium = TrustGradePremium.from_dict(d.pop("premium"))

        bond = TrustGradeBond.from_dict(d.pop("bond"))

        compute_ms = d.pop("computeMs")

        trust_grade = cls(
            v=v,
            agent_id=agent_id,
            grade=grade,
            computed_at=computed_at,
            calibration=calibration,
            evidence=evidence,
            reserve=reserve,
            frequency=frequency,
            severity=severity,
            loss=loss,
            premium=premium,
            bond=bond,
            compute_ms=compute_ms,
        )

        trust_grade.additional_properties = d
        return trust_grade

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
