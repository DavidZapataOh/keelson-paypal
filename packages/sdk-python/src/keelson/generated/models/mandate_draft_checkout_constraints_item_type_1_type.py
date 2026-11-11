from typing import Literal

MandateDraftCheckoutConstraintsItemType1Type = Literal["checkout.line_items"]

MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_1_TYPE_VALUES: set[
    MandateDraftCheckoutConstraintsItemType1Type
] = {
    "checkout.line_items",
}


def check_mandate_draft_checkout_constraints_item_type_1_type(
    value: str,
) -> MandateDraftCheckoutConstraintsItemType1Type:
    if value in MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_1_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_1_TYPE_VALUES!r}"
    )
