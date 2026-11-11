from typing import Literal

CoverageRowsRequestFilterModelDisputeStateType3Type = Literal[
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

COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_3_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelDisputeStateType3Type
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


def check_coverage_rows_request_filter_model_dispute_state_type_3_type(
    value: str,
) -> CoverageRowsRequestFilterModelDisputeStateType3Type:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_3_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_3_TYPE_VALUES!r}"
    )
