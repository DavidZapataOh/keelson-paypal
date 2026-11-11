from typing import Literal

MandateDraftPaymentConstraintsItemType4MccTable = Literal["v1"]

MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_4_MCC_TABLE_VALUES: set[
    MandateDraftPaymentConstraintsItemType4MccTable
] = {
    "v1",
}


def check_mandate_draft_payment_constraints_item_type_4_mcc_table(
    value: str,
) -> MandateDraftPaymentConstraintsItemType4MccTable:
    if value in MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_4_MCC_TABLE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_4_MCC_TABLE_VALUES!r}"
    )
