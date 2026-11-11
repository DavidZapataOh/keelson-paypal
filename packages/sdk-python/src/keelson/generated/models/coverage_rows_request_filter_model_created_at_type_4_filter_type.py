from typing import Literal

CoverageRowsRequestFilterModelCreatedAtType4FilterType = Literal["set"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_4_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelCreatedAtType4FilterType
] = {
    "set",
}


def check_coverage_rows_request_filter_model_created_at_type_4_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelCreatedAtType4FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_4_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_4_FILTER_TYPE_VALUES!r}"
    )
