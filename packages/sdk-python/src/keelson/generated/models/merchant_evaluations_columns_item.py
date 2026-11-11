from typing import Literal

MerchantEvaluationsColumnsItem = Literal[
    "agent",
    "at",
    "attack_class",
    "color",
    "decision",
    "dispute_id",
    "evaluation_id",
    "failed",
    "field",
    "liable",
    "operator",
    "source",
]

MERCHANT_EVALUATIONS_COLUMNS_ITEM_VALUES: set[MerchantEvaluationsColumnsItem] = {
    "agent",
    "at",
    "attack_class",
    "color",
    "decision",
    "dispute_id",
    "evaluation_id",
    "failed",
    "field",
    "liable",
    "operator",
    "source",
}


def check_merchant_evaluations_columns_item(value: str) -> MerchantEvaluationsColumnsItem:
    if value in MERCHANT_EVALUATIONS_COLUMNS_ITEM_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_EVALUATIONS_COLUMNS_ITEM_VALUES!r}"
    )
