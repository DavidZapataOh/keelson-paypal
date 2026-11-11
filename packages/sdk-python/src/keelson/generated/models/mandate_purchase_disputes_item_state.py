from typing import Literal

MandatePurchaseDisputesItemState = Literal["ATTRIBUTED", "OPEN", "RESOLVED"]

MANDATE_PURCHASE_DISPUTES_ITEM_STATE_VALUES: set[MandatePurchaseDisputesItemState] = {
    "ATTRIBUTED",
    "OPEN",
    "RESOLVED",
}


def check_mandate_purchase_disputes_item_state(value: str) -> MandatePurchaseDisputesItemState:
    if value in MANDATE_PURCHASE_DISPUTES_ITEM_STATE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_PURCHASE_DISPUTES_ITEM_STATE_VALUES!r}"
    )
