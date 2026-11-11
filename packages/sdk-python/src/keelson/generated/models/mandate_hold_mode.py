from typing import Literal

MandateHoldMode = Literal["mandate", "per_purchase"]

MANDATE_HOLD_MODE_VALUES: set[MandateHoldMode] = {
    "mandate",
    "per_purchase",
}


def check_mandate_hold_mode(value: str) -> MandateHoldMode:
    if value in MANDATE_HOLD_MODE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {MANDATE_HOLD_MODE_VALUES!r}")
