from typing import Literal

RevokingMandateState = Literal["REVOKING"]

REVOKING_MANDATE_STATE_VALUES: set[RevokingMandateState] = {
    "REVOKING",
}


def check_revoking_mandate_state(value: str) -> RevokingMandateState:
    if value in REVOKING_MANDATE_STATE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {REVOKING_MANDATE_STATE_VALUES!r}"
    )
