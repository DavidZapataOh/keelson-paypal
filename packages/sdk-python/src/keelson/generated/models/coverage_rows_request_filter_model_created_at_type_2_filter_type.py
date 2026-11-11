from typing import Literal

CoverageRowsRequestFilterModelCreatedAtType2FilterType = Literal["number"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_2_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelCreatedAtType2FilterType
] = {
    "number",
}


def check_coverage_rows_request_filter_model_created_at_type_2_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelCreatedAtType2FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_2_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_2_FILTER_TYPE_VALUES!r}"
    )
