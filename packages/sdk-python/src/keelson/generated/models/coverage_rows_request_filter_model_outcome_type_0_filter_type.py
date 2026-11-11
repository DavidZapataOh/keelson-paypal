from typing import Literal

CoverageRowsRequestFilterModelOutcomeType0FilterType = Literal["date", "number", "text"]

COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_0_FILTER_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelOutcomeType0FilterType
] = {
    "date",
    "number",
    "text",
}


def check_coverage_rows_request_filter_model_outcome_type_0_filter_type(
    value: str,
) -> CoverageRowsRequestFilterModelOutcomeType0FilterType:
    if value in COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_0_FILTER_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_OUTCOME_TYPE_0_FILTER_TYPE_VALUES!r}"
    )
