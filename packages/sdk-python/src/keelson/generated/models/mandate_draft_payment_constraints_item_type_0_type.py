from typing import Literal

MandateDraftPaymentConstraintsItemType0Type = Literal["payment.amount_range"]

MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_0_TYPE_VALUES: set[
    MandateDraftPaymentConstraintsItemType0Type
] = {
    "payment.amount_range",
}


def check_mandate_draft_payment_constraints_item_type_0_type(
    value: str,
) -> MandateDraftPaymentConstraintsItemType0Type:
    if value in MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_0_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_0_TYPE_VALUES!r}"
    )
