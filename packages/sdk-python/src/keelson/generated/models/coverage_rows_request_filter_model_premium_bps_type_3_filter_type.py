from typing import Literal

CoverageRowsRequestFilterModelPremiumBpsType3FilterType = Literal["date"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_3_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelPremiumBpsType3FilterType
] = {
    "date",
}


def check_coverage_rows_request_filter_model_premium_bps_type_3_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelPremiumBpsType3FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_3_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_3_FILTER_TYPE_VALUES!r}"
    )
