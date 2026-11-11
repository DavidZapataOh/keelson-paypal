from typing import Literal

MandateDraftPaymentConstraintsItemType4Type = Literal["payment.card_controls"]

MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_4_TYPE_VALUES: set[
    MandateDraftPaymentConstraintsItemType4Type
] = {
    "payment.card_controls",
}


def check_mandate_draft_payment_constraints_item_type_4_type(
    value: str,
) -> MandateDraftPaymentConstraintsItemType4Type:
    if value in MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_4_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_4_TYPE_VALUES!r}"
    )
