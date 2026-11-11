from typing import Literal

CoverageRowsRequestFilterModelIdType2Type = Literal[
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

COVERAGE_ROWS_REQUEST_FILTER_MODEL_ID_TYPE_2_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelIdType2Type
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


def check_coverage_rows_request_filter_model_id_type_2_type(
    value: str,
) -> CoverageRowsRequestFilterModelIdType2Type:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_ID_TYPE_2_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_ID_TYPE_2_TYPE_VALUES!r}"
    )
