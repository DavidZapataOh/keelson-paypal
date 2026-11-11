from typing import Literal

CoverageRowsRequestFilterModelCreatedAtType0ConditionsItemType1Type = Literal[
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

COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_0_CONDITIONS_ITEM_TYPE_1_TYPE_VALUES: set[
    CoverageRowsRequestFilterModelCreatedAtType0ConditionsItemType1Type
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


def check_coverage_rows_request_filter_model_created_at_type_0_conditions_item_type_1_type(
    value: str,
) -> CoverageRowsRequestFilterModelCreatedAtType0ConditionsItemType1Type:
    if (
        value
        in COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_0_CONDITIONS_ITEM_TYPE_1_TYPE_VALUES
    ):
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COVERAGE_ROWS_REQUEST_FILTER_MODEL_CREATED_AT_TYPE_0_CONDITIONS_ITEM_TYPE_1_TYPE_VALUES!r}"
    )
