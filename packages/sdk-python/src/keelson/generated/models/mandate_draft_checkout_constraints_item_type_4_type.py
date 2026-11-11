from typing import Literal

MandateDraftCheckoutConstraintsItemType4Type = Literal["keelson.returns"]

MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_4_TYPE_VALUES: set[
    MandateDraftCheckoutConstraintsItemType4Type
] = {
    "keelson.returns",
}


def check_mandate_draft_checkout_constraints_item_type_4_type(
    value: str,
) -> MandateDraftCheckoutConstraintsItemType4Type:
    if value in MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_4_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_4_TYPE_VALUES!r}"
    )
