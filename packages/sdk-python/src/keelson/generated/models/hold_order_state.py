from typing import Literal

HoldOrderState = Literal["HOLD_PENDING"]

HOLD_ORDER_STATE_VALUES: set[HoldOrderState] = {
    "HOLD_PENDING",
}


def check_hold_order_state(value: str) -> HoldOrderState:
    if value in HOLD_ORDER_STATE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {HOLD_ORDER_STATE_VALUES!r}")
