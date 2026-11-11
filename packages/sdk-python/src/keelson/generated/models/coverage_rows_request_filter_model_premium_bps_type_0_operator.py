from typing import Literal

CoverageRowsRequestFilterModelPremiumBpsType0Operator = Literal["AND", "OR"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_0_OPERATOR_VALUES: set[
    CoverageRowsRequestFilterModelPremiumBpsType0Operator
] = {
    "AND",
    "OR",
}


def check_coverage_rows_request_filter_model_premium_bps_type_0_operator(
    value: str,
) -> CoverageRowsRequestFilterModelPremiumBpsType0Operator:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_0_OPERATOR_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_0_OPERATOR_VALUES!r}"
    )
