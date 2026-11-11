from typing import Literal

CoverageRowsRequestFilterModelPremiumType0ConditionsItemType0FilterType = Literal["text"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_TYPE_0_CONDITIONS_ITEM_TYPE_0_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelPremiumType0ConditionsItemType0FilterType
] = {
    "text",
}


def check_coverage_rows_request_filter_model_premium_type_0_conditions_item_type_0_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelPremiumType0ConditionsItemType0FilterType:
    if (
        value
        in COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_TYPE_0_CONDITIONS_ITEM_TYPE_0_FILTER_TYPE_VALUES
    ):
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_PREMIUM_TYPE_0_CONDITIONS_ITEM_TYPE_0_FILTER_TYPE_VALUES!r}"
    )
