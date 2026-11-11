from typing import Literal

CoverageRowOutcomeType3Type1 = Literal["claimable", "failed", "paid", "queued"]

COVERAGE_ROW_OUTCOME_TYPE_3_TYPE_1_VALUES: set[CoverageRowOutcomeType3Type1] = {
    "claimable",
    "failed",
    "paid",
    "queued",
}


def check_coverage_row_outcome_type_3_type_1(value: str) -> CoverageRowOutcomeType3Type1:
    if value in COVERAGE_ROW_OUTCOME_TYPE_3_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROW_OUTCOME_TYPE_3_TYPE_1_VALUES!r}"
    )
