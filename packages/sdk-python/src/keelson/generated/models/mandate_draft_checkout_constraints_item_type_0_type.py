from typing import Literal

MandateDraftCheckoutConstraintsItemType0Type = Literal["checkout.allowed_merchants"]

MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_0_TYPE_VALUES: set[
    MandateDraftCheckoutConstraintsItemType0Type
] = {
    "checkout.allowed_merchants",
}


def check_mandate_draft_checkout_constraints_item_type_0_type(
    value: str,
) -> MandateDraftCheckoutConstraintsItemType0Type:
    if value in MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_0_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_0_TYPE_VALUES!r}"
    )
