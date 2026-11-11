from typing import Literal

CoverageRowsRequestFilterModelPremiumBpsType2FilterType = Literal["number"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_2_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelPremiumBpsType2FilterType
] = {
    "number",
}


def check_coverage_rows_request_filter_model_premium_bps_type_2_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelPremiumBpsType2FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_2_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_2_FILTER_TYPE_VALUES!r}"
    )
