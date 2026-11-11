from typing import Literal

PendingHoldState = Literal["HOLD_PENDING"]

PENDING_HOLD_STATE_VALUES: set[PendingHoldState] = {
    "HOLD_PENDING",
}


def check_pending_hold_state(value: str) -> PendingHoldState:
    if value in PENDING_HOLD_STATE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {PENDING_HOLD_STATE_VALUES!r}")
