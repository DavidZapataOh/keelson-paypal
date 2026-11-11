from typing import Literal

CoverageRowsRequestFilterModelIdType2FilterType = Literal["number"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_ID_TYPE_2_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelIdType2FilterType
] = {
    "number",
}


def check_coverage_rows_request_filter_model_id_type_2_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelIdType2FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_ID_TYPE_2_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_ID_TYPE_2_FILTER_TYPE_VALUES!r}"
    )
