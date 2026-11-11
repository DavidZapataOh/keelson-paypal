from typing import Literal

CoverageRowsRequestFilterModelOutcomeType4FilterType = Literal["set"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_4_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelOutcomeType4FilterType
] = {
    "set",
}


def check_coverage_rows_request_filter_model_outcome_type_4_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelOutcomeType4FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_4_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_4_FILTER_TYPE_VALUES!r}"
    )
