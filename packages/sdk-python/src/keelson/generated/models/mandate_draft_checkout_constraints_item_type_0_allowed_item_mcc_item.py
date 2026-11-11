from typing import Literal

MandateDraftCheckoutConstraintsItemType0AllowedItemMccItem = Literal[
    "4111",
    "4121",
    "5300",
    "5310",
    "5311",
    "5411",
    "5441",
    "5462",
    "5499",
    "5651",
    "5661",
    "5691",
    "5732",
    "5734",
    "5812",
    "5814",
    "5912",
    "5941",
    "5942",
    "5945",
    "5977",
    "5992",
    "5995",
    "5999",
    "7832",
]

MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_0_ALLOWED_ITEM_MCC_ITEM_VALUES: set[
    MandateDraftCheckoutConstraintsItemType0AllowedItemMccItem
] = {
    "4111",
    "4121",
    "5300",
    "5310",
    "5311",
    "5411",
    "5441",
    "5462",
    "5499",
    "5651",
    "5661",
    "5691",
    "5732",
    "5734",
    "5812",
    "5814",
    "5912",
    "5941",
    "5942",
    "5945",
    "5977",
    "5992",
    "5995",
    "5999",
    "7832",
}


def check_mandate_draft_checkout_constraints_item_type_0_allowed_item_mcc_item(
    value: str,
) -> MandateDraftCheckoutConstraintsItemType0AllowedItemMccItem:
    if value in MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_0_ALLOWED_ITEM_MCC_ITEM_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_CHECKOUT_CONSTRAINTS_ITEM_TYPE_0_ALLOWED_ITEM_MCC_ITEM_VALUES!r}"
    )
