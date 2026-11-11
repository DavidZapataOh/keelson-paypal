from typing import Literal

CoverageRowsRequestFilterModelLiableType1Type = Literal[
    "blank", "contains", "endsWith", "equals", "notBlank", "notContains", "notEqual", "startsWith"
]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_LIABLE_TYPE_1_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelLiableType1Type
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


def check_coverage_rows_request_filter_model_liable_type_1_type(
    value: str,
) -> CoverageRowsRequestFilterModelLiableType1Type:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_LIABLE_TYPE_1_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_LIABLE_TYPE_1_TYPE_VALUES!r}"
    )
