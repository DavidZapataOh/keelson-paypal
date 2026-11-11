from typing import Literal

CoverageRowsRequestFilterModelPaidByType2Type = Literal[
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

COVERAGE_ROWS_REQUEST_FILTER_MODEL_PAID_BY_TYPE_2_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelPaidByType2Type
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


def check_coverage_rows_request_filter_model_paid_by_type_2_type(
    value: str,
) -> CoverageRowsRequestFilterModelPaidByType2Type:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_PAID_BY_TYPE_2_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_PAID_BY_TYPE_2_TYPE_VALUES!r}"
    )
