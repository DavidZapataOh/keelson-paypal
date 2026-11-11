from typing import Literal

CoverageRowsRequestFilterModelStateType1Type = Literal[
    "blank", "contains", "endsWith", "equals", "notBlank", "notContains", "notEqual", "startsWith"
]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_STATE_TYPE_1_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelStateType1Type
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


def check_coverage_rows_request_filter_model_state_type_1_type(
    value: str,
) -> CoverageRowsRequestFilterModelStateType1Type:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_STATE_TYPE_1_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_STATE_TYPE_1_TYPE_VALUES!r}"
    )
