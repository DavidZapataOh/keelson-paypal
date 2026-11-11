from typing import Literal

CoverageRowsRequestFilterModelDisputeStateType0Operator = Literal["AND", "OR"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_0_OPERATOR_VALUES: set[
    CoverageRowsRequestFilterModelDisputeStateType0Operator
] = {
    "AND",
    "OR",
}


def check_coverage_rows_request_filter_model_dispute_state_type_0_operator(
    value: str,
) -> CoverageRowsRequestFilterModelDisputeStateType0Operator:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_0_OPERATOR_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_0_OPERATOR_VALUES!r}"
    )
