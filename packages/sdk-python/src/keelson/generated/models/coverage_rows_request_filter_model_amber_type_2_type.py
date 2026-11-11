from typing import Literal

CoverageRowsRequestFilterModelAmberType2Type = Literal[
    "blank",
    "equals",
    "greaterThan",
    "greaterThanOrEqual",
    "inRange",
    "lessThan",
    "lessThanOrEqual",
    "notBlank",
    "notEqual",
]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_AMBER_TYPE_2_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelAmberType2Type
] = {
    "blank",
    "equals",
    "greaterThan",
    "greaterThanOrEqual",
    "inRange",
    "lessThan",
    "lessThanOrEqual",
    "notBlank",
    "notEqual",
}


def check_coverage_rows_request_filter_model_amber_type_2_type(
    value: str,
) -> CoverageRowsRequestFilterModelAmberType2Type:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_AMBER_TYPE_2_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_AMBER_TYPE_2_TYPE_VALUES!r}"
    )
