from typing import Literal

CoverageRowAmber = Literal["attested", "contradicted", "none"]

COVERAGE_ROW_AMBER_VALUES: set[CoverageRowAmber] = {
    "attested",
    "contradicted",
    "none",
}


def check_coverage_row_amber(value: str) -> CoverageRowAmber:
    if value in COVERAGE_ROW_AMBER_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {COVERAGE_ROW_AMBER_VALUES!r}")
