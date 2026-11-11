from typing import Literal

CoverageRowOutcomeType1 = Literal["claimable", "failed", "paid", "queued"]

COVERAGE_ROW_OUTCOME_TYPE_1_VALUES: set[CoverageRowOutcomeType1] = {
    "claimable",
    "failed",
    "paid",
    "queued",
}


def check_coverage_row_outcome_type_1(value: str) -> CoverageRowOutcomeType1:
    if value in COVERAGE_ROW_OUTCOME_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROW_OUTCOME_TYPE_1_VALUES!r}"
    )
