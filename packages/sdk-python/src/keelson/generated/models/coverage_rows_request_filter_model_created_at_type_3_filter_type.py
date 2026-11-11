from typing import Literal

CoverageRowsRequestFilterModelCreatedAtType3FilterType = Literal["date"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_3_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelCreatedAtType3FilterType
] = {
    "date",
}


def check_coverage_rows_request_filter_model_created_at_type_3_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelCreatedAtType3FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_3_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_3_FILTER_TYPE_VALUES!r}"
    )
