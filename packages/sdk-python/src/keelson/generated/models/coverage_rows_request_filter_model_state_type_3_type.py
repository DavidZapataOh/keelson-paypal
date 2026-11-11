from typing import Literal

CoverageRowsRequestFilterModelStateType3Type = Literal[
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

COVERAGE_ROWS_REQUEST_FILTER_MODEL_STATE_TYPE_3_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelStateType3Type
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


def check_coverage_rows_request_filter_model_state_type_3_type(
    value: str,
) -> CoverageRowsRequestFilterModelStateType3Type:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_STATE_TYPE_3_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_STATE_TYPE_3_TYPE_VALUES!r}"
    )
