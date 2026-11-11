from typing import Literal

MandateHoldState = Literal["AUTHORIZED", "PENDING", "RELEASED"]

MANDATE_HOLD_STATE_VALUES: set[MandateHoldState] = {
    "AUTHORIZED",
    "PENDING",
    "RELEASED",
}


def check_mandate_hold_state(value: str) -> MandateHoldState:
    if value in MANDATE_HOLD_STATE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {MANDATE_HOLD_STATE_VALUES!r}")
