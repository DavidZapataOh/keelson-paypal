from typing import Literal

MandateDraftCheckoutConstraintsItemType2Type = Literal["keelson.category"]

MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_2_TYPE_VALUES: set[
    MandateDraftCheckoutConstraintsItemType2Type
] = {
    "keelson.category",
}


def check_mandate_draft_checkout_constraints_item_type_2_type(
    value: str,
) -> MandateDraftCheckoutConstraintsItemType2Type:
    if value in MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_2_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_2_TYPE_VALUES!r}"
    )
