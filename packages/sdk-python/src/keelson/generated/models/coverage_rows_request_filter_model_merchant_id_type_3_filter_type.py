from typing import Literal

CoverageRowsRequestFilterModelMerchantIdType3FilterType = Literal["date"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_3_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelMerchantIdType3FilterType
] = {
    "date",
}


def check_coverage_rows_request_filter_model_merchant_id_type_3_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelMerchantIdType3FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_3_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_3_FILTER_TYPE_VALUES!r}"
    )
