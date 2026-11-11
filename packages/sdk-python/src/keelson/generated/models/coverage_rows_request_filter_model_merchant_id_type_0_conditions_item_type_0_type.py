from typing import Literal

CoverageRowsRequestFilterModelMerchantIdType0ConditionsItemType0Type = Literal[
    "blank", "contains", "endsWith", "equals", "notBlank", "notContains", "notEqual", "startsWith"
]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_0_CONDITIONS_ITEM_TYPE_0_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelMerchantIdType0ConditionsItemType0Type
] = {
    "blank",
    "contains",
    "endsWith",
    "equals",
    "notBlank",
    "notContains",
    "notEqual",
    "startsWith",
}


def check_coverage_rows_request_filter_model_merchant_id_type_0_conditions_item_type_0_type(
    value: str,
) -> CoverageRowsRequestFilterModelMerchantIdType0ConditionsItemType0Type:
    if (
        value
        in COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_0_CONDITIONS_ITEM_TYPE_0_TYPE_VALUES
    ):
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_0_CONDITIONS_ITEM_TYPE_0_TYPE_VALUES!r}"
    )
