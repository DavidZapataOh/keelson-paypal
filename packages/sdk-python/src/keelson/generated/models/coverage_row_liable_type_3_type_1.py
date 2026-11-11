from typing import Literal

CoverageRowLiableType3Type1 = Literal["keelson", "merchant", "operator", "user"]

COVERAGE_ROW_LIABLE_TYPE_3_TYPE_1_VALUES: set[CoverageRowLiableType3Type1] = {
    "keelson",
    "merchant",
    "operator",
    "user",
}


def check_coverage_row_liable_type_3_type_1(value: str) -> CoverageRowLiableType3Type1:
    if value in COVERAGE_ROW_LIABLE_TYPE_3_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROW_LIABLE_TYPE_3_TYPE_1_VALUES!r}"
    )
