from typing import Literal

CoverageRowsRequestFilterModelOutcomeType0Operator = Literal["AND", "OR"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_0_OPERATOR_VALUES: set[
    CoverageRowsRequestFilterModelOutcomeType0Operator
] = {
    "AND",
    "OR",
}


def check_coverage_rows_request_filter_model_outcome_type_0_operator(
    value: str,
) -> CoverageRowsRequestFilterModelOutcomeType0Operator:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_0_OPERATOR_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_0_OPERATOR_VALUES!r}"
    )
