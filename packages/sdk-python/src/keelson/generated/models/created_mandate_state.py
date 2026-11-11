from typing import Literal

CreatedMandateState = Literal["ACTIVE", "SIGNED"]

CREATED_MANDATE_STATE_VALUES: set[CreatedMandateState] = {
    "ACTIVE",
    "SIGNED",
}


def check_created_mandate_state(value: str) -> CreatedMandateState:
    if value in CREATED_MANDATE_STATE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {CREATED_MANDATE_STATE_VALUES!r}")
