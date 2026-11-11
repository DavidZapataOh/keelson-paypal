from typing import Literal

MandateDraftPaymentConstraintsItemType1Type = Literal["payment.budget"]

MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_1_TYPE_VALUES: set[
    MandateDraftPaymentConstraintsItemType1Type
] = {
    "payment.budget",
}


def check_mandate_draft_payment_constraints_item_type_1_type(
    value: str,
) -> MandateDraftPaymentConstraintsItemType1Type:
    if value in MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_1_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_1_TYPE_VALUES!r}"
    )
