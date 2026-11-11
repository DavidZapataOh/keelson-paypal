from typing import Literal

CoverageRowsRequestFilterModelIdType3FilterType = Literal["date"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_ID_TYPE_3_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelIdType3FilterType
] = {
    "date",
}


def check_coverage_rows_request_filter_model_id_type_3_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelIdType3FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_ID_TYPE_3_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_ID_TYPE_3_FILTER_TYPE_VALUES!r}"
    )
