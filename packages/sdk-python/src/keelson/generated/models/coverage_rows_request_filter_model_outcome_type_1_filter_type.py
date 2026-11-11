from typing import Literal

CoverageRowsRequestFilterModelOutcomeType1FilterType = Literal["text"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_1_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelOutcomeType1FilterType
] = {
    "text",
}


def check_coverage_rows_request_filter_model_outcome_type_1_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelOutcomeType1FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_1_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_1_FILTER_TYPE_VALUES!r}"
    )
