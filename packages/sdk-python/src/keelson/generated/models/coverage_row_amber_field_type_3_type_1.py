from typing import Literal

CoverageRowAmberFieldType3Type1 = Literal["color", "returns_free", "size", "unit_price"]

COVERAGE_ROW_AMBER_FIELD_TYPE_3_TYPE_1_VALUES: set[CoverageRowAmberFieldType3Type1] = {
    "color",
    "returns_free",
    "size",
    "unit_price",
}


def check_coverage_row_amber_field_type_3_type_1(value: str) -> CoverageRowAmberFieldType3Type1:
    if value in COVERAGE_ROW_AMBER_FIELD_TYPE_3_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROW_AMBER_FIELD_TYPE_3_TYPE_1_VALUES!r}"
    )
