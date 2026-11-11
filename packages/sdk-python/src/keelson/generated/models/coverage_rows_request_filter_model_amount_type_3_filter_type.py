from typing import Literal

CoverageRowsRequestFilterModelAmountType3FilterType = Literal["date"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_AMOUNT_TYPE_3_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelAmountType3FilterType
] = {
    "date",
}


def check_coverage_rows_request_filter_model_amount_type_3_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelAmountType3FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_AMOUNT_TYPE_3_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_AMOUNT_TYPE_3_FILTER_TYPE_VALUES!r}"
    )
