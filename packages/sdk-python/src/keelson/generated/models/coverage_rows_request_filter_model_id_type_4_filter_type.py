from typing import Literal

CoverageRowsRequestFilterModelIdType4FilterType = Literal["set"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_ID_TYPE_4_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelIdType4FilterType
] = {
    "set",
}


def check_coverage_rows_request_filter_model_id_type_4_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelIdType4FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_ID_TYPE_4_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_ID_TYPE_4_FILTER_TYPE_VALUES!r}"
    )
