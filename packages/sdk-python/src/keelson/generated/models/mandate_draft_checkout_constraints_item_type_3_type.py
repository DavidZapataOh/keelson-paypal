from typing import Literal

MandateDraftCheckoutConstraintsItemType3Type = Literal["keelson.attributes"]

MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_3_TYPE_VALUES: set[
    MandateDraftCheckoutConstraintsItemType3Type
] = {
    "keelson.attributes",
}


def check_mandate_draft_checkout_constraints_item_type_3_type(
    value: str,
) -> MandateDraftCheckoutConstraintsItemType3Type:
    if value in MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_3_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_3_TYPE_VALUES!r}"
    )
