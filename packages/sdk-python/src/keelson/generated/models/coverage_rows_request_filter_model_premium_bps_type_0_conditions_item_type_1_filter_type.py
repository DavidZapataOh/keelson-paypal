from typing import Literal

CoverageRowsRequestFilterModelPremiumBpsType0ConditionsItemType1FilterType = Literal["number"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_0_CONDITIONS_ITEM_TYPE_1_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelPremiumBpsType0ConditionsItemType1FilterType
] = {
    "number",
}


def check_coverage_rows_request_filter_model_premium_bps_type_0_conditions_item_type_1_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelPremiumBpsType0ConditionsItemType1FilterType:
    if (
        value
        in COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_0_CONDITIONS_ITEM_TYPE_1_FILTER_TYPE_VALUES
    ):
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_BPS_TYPE_0_CONDITIONS_ITEM_TYPE_1_FILTER_TYPE_VALUES!r}"
    )
