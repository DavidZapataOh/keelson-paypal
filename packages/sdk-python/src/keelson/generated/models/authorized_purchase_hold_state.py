from typing import Literal

AuthorizedPurchaseHoldState = Literal["AUTHORIZED", "PENDING"]

AUTHORIZED_PURCHASE_HOLD_STATE_VALUES: set[AuthorizedPurchaseHoldState] = {
    "AUTHORIZED",
    "PENDING",
}


def check_authorized_purchase_hold_state(value: str) -> AuthorizedPurchaseHoldState:
    if value in AUTHORIZED_PURCHASE_HOLD_STATE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {AUTHORIZED_PURCHASE_HOLD_STATE_VALUES!r}"
    )
