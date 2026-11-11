from typing import Literal

CoverageRowsRequestSortModelItemSort = Literal["asc", "desc"]

COVERAGE_ROWS_REQUEST_SORT_MODEL_ITEM_SORT_VALUES: set[CoverageRowsRequestSortModelItemSort] = {
    "asc",
    "desc",
}


def check_coverage_rows_request_sort_model_item_sort(
    value: str,
) -> CoverageRowsRequestSortModelItemSort:
    if value in COVERAGE_ROWS_REQUEST_SORT_MODEL_ITEM_SORT_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_SORT_MODEL_ITEM_SORT_VALUES!r}"
    )
