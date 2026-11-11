from typing import Literal

TrustGradeV = Literal["keelson.grade/1"]

TRUST_GRADE_V_VALUES: set[TrustGradeV] = {
    "keelson.grade/1",
}


def check_trust_grade_v(value: str) -> TrustGradeV:
    if value in TRUST_GRADE_V_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {TRUST_GRADE_V_VALUES!r}")
