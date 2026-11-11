from typing import Literal

CoverageRowsRequestFilterModelCreatedAtType3Type = Literal[
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

COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_3_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelCreatedAtType3Type
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


def check_coverage_rows_request_filter_model_created_at_type_3_type(
    value: str,
) -> CoverageRowsRequestFilterModelCreatedAtType3Type:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_3_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_3_TYPE_VALUES!r}"
    )
