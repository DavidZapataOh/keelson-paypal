from typing import Literal

CoverageRowsRequestFilterModelAmberType0Operator = Literal["AND", "OR"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_AMBER_TYPE_0_OPERATOR_VALUES: set[
    CoverageRowsRequestFilterModelAmberType0Operator
] = {
    "AND",
    "OR",
}


def check_coverage_rows_request_filter_model_amber_type_0_operator(
    value: str,
) -> CoverageRowsRequestFilterModelAmberType0Operator:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_AMBER_TYPE_0_OPERATOR_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_AMBER_TYPE_0_OPERATOR_VALUES!r}"
    )
