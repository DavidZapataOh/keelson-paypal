from typing import Literal

CoverageRowsRequestFilterModelDisputeStateType4FilterType = Literal["set"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_4_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelDisputeStateType4FilterType
] = {
    "set",
}


def check_coverage_rows_request_filter_model_dispute_state_type_4_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelDisputeStateType4FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_4_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_4_FILTER_TYPE_VALUES!r}"
    )
