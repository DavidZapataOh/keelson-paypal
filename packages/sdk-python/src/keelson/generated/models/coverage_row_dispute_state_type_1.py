from typing import Literal

CoverageRowDisputeStateType1 = Literal["ATTRIBUTED", "OPEN", "RESOLVED"]

COVERAGE_ROW_DISPUTE_STATE_TYPE_1_VALUES: set[CoverageRowDisputeStateType1] = {
    "ATTRIBUTED",
    "OPEN",
    "RESOLVED",
}


def check_coverage_row_dispute_state_type_1(value: str) -> CoverageRowDisputeStateType1:
    if value in COVERAGE_ROW_DISPUTE_STATE_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROW_DISPUTE_STATE_TYPE_1_VALUES!r}"
    )
