from typing import Literal

CoverageRowsRequestFilterModelOutcomeType2FilterType = Literal["number"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_2_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelOutcomeType2FilterType
] = {
    "number",
}


def check_coverage_rows_request_filter_model_outcome_type_2_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelOutcomeType2FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_2_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_2_FILTER_TYPE_VALUES!r}"
    )
