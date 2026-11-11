from typing import Literal

CoverageRowsRequestSortModelItemColId = Literal[
    "amber",
    "amount",
    "createdAt",
    "disputeState",
    "id",
    "liable",
    "merchantId",
    "outcome",
    "paidBy",
    "premium",
    "premiumBps",
    "state",
]

COVERAGE_ROWS_REQUEST_SORT_MODEL_ITEM_COL_ID_VALUES: set[CoverageRowsRequestSortModelItemColId] = {
    "amber",
    "amount",
    "createdAt",
    "disputeState",
    "id",
    "liable",
    "merchantId",
    "outcome",
    "paidBy",
    "premium",
    "premiumBps",
    "state",
}


def check_coverage_rows_request_sort_model_item_col_id(
    value: str,
) -> CoverageRowsRequestSortModelItemColId:
    if value in COVERAGE_ROWS_REQUEST_SORT_MODEL_ITEM_COL_ID_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_SORT_MODEL_ITEM_COL_ID_VALUES!r}"
    )
