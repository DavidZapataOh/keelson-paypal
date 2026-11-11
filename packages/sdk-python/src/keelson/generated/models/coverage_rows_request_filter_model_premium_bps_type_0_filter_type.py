from typing import Literal

CoverageRowsRequestFilterModelPremiumBpsType0FilterType = Literal["date", "number", "text"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_0_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelPremiumBpsType0FilterType
] = {
    "date",
    "number",
    "text",
}


def check_coverage_rows_request_filter_model_premium_bps_type_0_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelPremiumBpsType0FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_0_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_0_FILTER_TYPE_VALUES!r}"
    )
