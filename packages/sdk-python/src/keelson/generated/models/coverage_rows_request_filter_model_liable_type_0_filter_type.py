from typing import Literal

CoverageRowsRequestFilterModelLiableType0FilterType = Literal["date", "number", "text"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_LIABLE_TYPE_0_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelLiableType0FilterType
] = {
    "date",
    "number",
    "text",
}


def check_coverage_rows_request_filter_model_liable_type_0_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelLiableType0FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_LIABLE_TYPE_0_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_LIABLE_TYPE_0_FILTER_TYPE_VALUES!r}"
    )
