from typing import Literal

RevokedMandateState = Literal["REVOKED"]

REVOKED_MANDATE_STATE_VALUES: set[RevokedMandateState] = {
    "REVOKED",
}


def check_revoked_mandate_state(value: str) -> RevokedMandateState:
    if value in REVOKED_MANDATE_STATE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {REVOKED_MANDATE_STATE_VALUES!r}")
