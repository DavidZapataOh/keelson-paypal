from typing import Literal

AuthorizedHoldState = Literal["ACTIVE"]

AUTHORIZED_HOLD_STATE_VALUES: set[AuthorizedHoldState] = {
    "ACTIVE",
}


def check_authorized_hold_state(value: str) -> AuthorizedHoldState:
    if value in AUTHORIZED_HOLD_STATE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {AUTHORIZED_HOLD_STATE_VALUES!r}")
