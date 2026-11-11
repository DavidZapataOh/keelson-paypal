from typing import Literal

CoverageRowsRequestFilterModelStateType0FilterType = Literal["date", "number", "text"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_STATE_TYPE_0_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelStateType0FilterType
] = {
    "date",
    "number",
    "text",
}


def check_coverage_rows_request_filter_model_state_type_0_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelStateType0FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_STATE_TYPE_0_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_STATE_TYPE_0_FILTER_TYPE_VALUES!r}"
    )
