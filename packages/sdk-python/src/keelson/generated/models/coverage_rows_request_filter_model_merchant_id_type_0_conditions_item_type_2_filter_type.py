from typing import Literal

CoverageRowsRequestFilterModelMerchantIdType0ConditionsItemType2FilterType = Literal["date"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_0_CONDITIONS_ITEM_TYPE_2_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelMerchantIdType0ConditionsItemType2FilterType
] = {
    "date",
}


def check_coverage_rows_request_filter_model_merchant_id_type_0_conditions_item_type_2_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelMerchantIdType0ConditionsItemType2FilterType:
    if (
        value
        in COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_0_CONDITIONS_ITEM_TYPE_2_FILTER_TYPE_VALUES
    ):
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_0_CONDITIONS_ITEM_TYPE_2_FILTER_TYPE_VALUES!r}"
    )
