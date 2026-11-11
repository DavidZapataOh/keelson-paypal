from typing import Literal

DisputeStatusState = Literal["ATTRIBUTED", "OPEN", "RESOLVED"]

DISPUTE_STATUS_STATE_VALUES: set[DisputeStatusState] = {
    "ATTRIBUTED",
    "OPEN",
    "RESOLVED",
}


def check_dispute_status_state(value: str) -> DisputeStatusState:
    if value in DISPUTE_STATUS_STATE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {DISPUTE_STATUS_STATE_VALUES!r}")
