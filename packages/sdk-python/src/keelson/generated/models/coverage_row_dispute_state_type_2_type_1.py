from typing import Literal

CoverageRowDisputeStateType2Type1 = Literal["ATTRIBUTED", "OPEN", "RESOLVED"]

COVERAGE_ROW_DISPUTE_STATE_TYPE_2_TYPE_1_VALUES: set[CoverageRowDisputeStateType2Type1] = {
    "ATTRIBUTED",
    "OPEN",
    "RESOLVED",
}


def check_coverage_row_dispute_state_type_2_type_1(value: str) -> CoverageRowDisputeStateType2Type1:
    if value in COVERAGE_ROW_DISPUTE_STATE_TYPE_2_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROW_DISPUTE_STATE_TYPE_2_TYPE_1_VALUES!r}"
    )
