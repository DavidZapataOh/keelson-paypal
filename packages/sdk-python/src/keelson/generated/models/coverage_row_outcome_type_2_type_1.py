from typing import Literal

CoverageRowOutcomeType2Type1 = Literal["claimable", "failed", "paid", "queued"]

COVERAGE_ROW_OUTCOME_TYPE_2_TYPE_1_VALUES: set[CoverageRowOutcomeType2Type1] = {
    "claimable",
    "failed",
    "paid",
    "queued",
}


def check_coverage_row_outcome_type_2_type_1(value: str) -> CoverageRowOutcomeType2Type1:
    if value in COVERAGE_ROW_OUTCOME_TYPE_2_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROW_OUTCOME_TYPE_2_TYPE_1_VALUES!r}"
    )
