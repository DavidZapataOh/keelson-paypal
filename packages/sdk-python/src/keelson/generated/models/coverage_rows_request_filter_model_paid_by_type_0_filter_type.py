from typing import Literal

CoverageRowsRequestFilterModelPaidByType0FilterType = Literal["date", "number", "text"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_PAID_BY_TYPE_0_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelPaidByType0FilterType
] = {
    "date",
    "number",
    "text",
}


def check_coverage_rows_request_filter_model_paid_by_type_0_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelPaidByType0FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_PAID_BY_TYPE_0_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_PAID_BY_TYPE_0_FILTER_TYPE_VALUES!r}"
    )
