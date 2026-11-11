from typing import Literal

MandateState = Literal[
    "ACTIVE", "COMPILED", "DRAFT", "EXHAUSTED", "EXPIRED", "HOLD_PENDING", "REVOKED", "SIGNED"
]

MANDATE_STATE_VALUES: set[MandateState] = {
    "ACTIVE",
    "COMPILED",
    "DRAFT",
    "EXHAUSTED",
    "EXPIRED",
    "HOLD_PENDING",
    "REVOKED",
    "SIGNED",
}


def check_mandate_state(value: str) -> MandateState:
    if value in MANDATE_STATE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {MANDATE_STATE_VALUES!r}")
