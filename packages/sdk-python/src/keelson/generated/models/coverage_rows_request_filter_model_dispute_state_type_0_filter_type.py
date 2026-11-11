from typing import Literal

CoverageRowsRequestFilterModelDisputeStateType0FilterType = Literal["date", "number", "text"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_0_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelDisputeStateType0FilterType
] = {
    "date",
    "number",
    "text",
}


def check_coverage_rows_request_filter_model_dispute_state_type_0_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelDisputeStateType0FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_0_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_DISPUTE_STATE_TYPE_0_FILTER_TYPE_VALUES!r}"
    )
