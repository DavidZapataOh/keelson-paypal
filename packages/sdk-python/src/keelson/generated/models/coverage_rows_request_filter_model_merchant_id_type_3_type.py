from typing import Literal

CoverageRowsRequestFilterModelMerchantIdType3Type = Literal[
    "blank",
    "equals",
    "greaterThan",
    "greaterThanOrEqual",
    "inRange",
    "lessThan",
    "lessThanOrEqual",
    "notBlank",
    "notEqual",
]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_3_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelMerchantIdType3Type
] = {
    "blank",
    "equals",
    "greaterThan",
    "greaterThanOrEqual",
    "inRange",
    "lessThan",
    "lessThanOrEqual",
    "notBlank",
    "notEqual",
}


def check_coverage_rows_request_filter_model_merchant_id_type_3_type(
    value: str,
) -> CoverageRowsRequestFilterModelMerchantIdType3Type:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_3_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_3_TYPE_VALUES!r}"
    )
