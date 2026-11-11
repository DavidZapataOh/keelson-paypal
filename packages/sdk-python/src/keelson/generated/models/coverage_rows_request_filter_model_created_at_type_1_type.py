from typing import Literal

CoverageRowsRequestFilterModelCreatedAtType1Type = Literal[
    "blank", "contains", "endsWith", "equals", "notBlank", "notContains", "notEqual", "startsWith"
]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_1_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelCreatedAtType1Type
] = {
    "blank",
    "contains",
    "endsWith",
    "equals",
    "notBlank",
    "notContains",
    "notEqual",
    "startsWith",
}


def check_coverage_rows_request_filter_model_created_at_type_1_type(
    value: str,
) -> CoverageRowsRequestFilterModelCreatedAtType1Type:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_1_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_1_TYPE_VALUES!r}"
    )
