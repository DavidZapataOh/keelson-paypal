from typing import Literal

CoverageRowsRequestFilterModelCreatedAtType2Type = Literal[
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

COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_2_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelCreatedAtType2Type
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


def check_coverage_rows_request_filter_model_created_at_type_2_type(
    value: str,
) -> CoverageRowsRequestFilterModelCreatedAtType2Type:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_2_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_2_TYPE_VALUES!r}"
    )
