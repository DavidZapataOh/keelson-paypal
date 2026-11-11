from typing import Literal

CoverageRowsRequestFilterModelMerchantIdType2FilterType = Literal["number"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_2_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelMerchantIdType2FilterType
] = {
    "number",
}


def check_coverage_rows_request_filter_model_merchant_id_type_2_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelMerchantIdType2FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_2_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_MERCHANT_ID_TYPE_2_FILTER_TYPE_VALUES!r}"
    )
