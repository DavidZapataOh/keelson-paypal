from typing import Literal

MandateDraftPaymentConstraintsItemType3Type = Literal["payment.execution_date"]

MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_3_TYPE_VALUES: set[
    MandateDraftPaymentConstraintsItemType3Type
] = {
    "payment.execution_date",
}


def check_mandate_draft_payment_constraints_item_type_3_type(
    value: str,
) -> MandateDraftPaymentConstraintsItemType3Type:
    if value in MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_3_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_3_TYPE_VALUES!r}"
    )
