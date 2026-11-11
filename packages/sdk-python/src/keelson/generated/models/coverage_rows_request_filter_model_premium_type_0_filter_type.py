from typing import Literal

CoverageRowsRequestFilterModelPremiumType0FilterType = Literal["date", "number", "text"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_TYPE_0_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelPremiumType0FilterType
] = {
    "date",
    "number",
    "text",
}


def check_coverage_rows_request_filter_model_premium_type_0_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelPremiumType0FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_TYPE_0_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_TYPE_0_FILTER_TYPE_VALUES!r}"
    )
