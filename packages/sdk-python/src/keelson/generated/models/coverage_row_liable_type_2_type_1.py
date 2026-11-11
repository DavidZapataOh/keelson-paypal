from typing import Literal

CoverageRowLiableType2Type1 = Literal["keelson", "merchant", "operator", "user"]

COVERAGE_ROW_LIABLE_TYPE_2_TYPE_1_VALUES: set[CoverageRowLiableType2Type1] = {
    "keelson",
    "merchant",
    "operator",
    "user",
}


def check_coverage_row_liable_type_2_type_1(value: str) -> CoverageRowLiableType2Type1:
    if value in COVERAGE_ROW_LIABLE_TYPE_2_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROW_LIABLE_TYPE_2_TYPE_1_VALUES!r}"
    )
