from typing import Literal

CoverageRowPaidByType2Type1 = Literal["chain", "treasury", "violation-pool"]

COVERAGE_ROW_PAID_BY_TYPE_2_TYPE_1_VALUES: set[CoverageRowPaidByType2Type1] = {
    "chain",
    "treasury",
    "violation-pool",
}


def check_coverage_row_paid_by_type_2_type_1(value: str) -> CoverageRowPaidByType2Type1:
    if value in COVERAGE_ROW_PAID_BY_TYPE_2_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROW_PAID_BY_TYPE_2_TYPE_1_VALUES!r}"
    )
