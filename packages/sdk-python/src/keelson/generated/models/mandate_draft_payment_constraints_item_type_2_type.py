from typing import Literal

MandateDraftPaymentConstraintsItemType2Type = Literal["payment.allowed_payees"]

MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_2_TYPE_VALUES: set[
    MandateDraftPaymentConstraintsItemType2Type
] = {
    "payment.allowed_payees",
}


def check_mandate_draft_payment_constraints_item_type_2_type(
    value: str,
) -> MandateDraftPaymentConstraintsItemType2Type:
    if value in MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_2_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_2_TYPE_VALUES!r}"
    )
