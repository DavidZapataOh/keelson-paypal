from typing import Literal

CoverageRowsRequestFilterModelDisputeStateType1FilterType = Literal["text"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_1_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelDisputeStateType1FilterType
] = {
    "text",
}


def check_coverage_rows_request_filter_model_dispute_state_type_1_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelDisputeStateType1FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_1_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_1_FILTER_TYPE_VALUES!r}"
    )
