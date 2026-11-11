from typing import Literal

TrustGradeGrade = Literal["A", "B", "C", "D", "F"]

TRUST_GRADE_GRADE_VALUES: set[TrustGradeGrade] = {
    "A",
    "B",
    "C",
    "D",
    "F",
}


def check_trust_grade_grade(value: str) -> TrustGradeGrade:
    if value in TRUST_GRADE_GRADE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {TRUST_GRADE_GRADE_VALUES!r}")
