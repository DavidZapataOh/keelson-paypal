from typing import Literal

CoverageRowsRequestFilterModelStateType2FilterType = Literal["number"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_STATE_TYPE_2_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelStateType2FilterType
] = {
    "number",
}


def check_coverage_rows_request_filter_model_state_type_2_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelStateType2FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_STATE_TYPE_2_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_STATE_TYPE_2_FILTER_TYPE_VALUES!r}"
    )
