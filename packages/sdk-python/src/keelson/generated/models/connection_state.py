from typing import Literal

ConnectionState = Literal["APPROVED", "DENIED", "EXPIRED", "PENDING"]

CONNECTION_STATE_VALUES: set[ConnectionState] = {
    "APPROVED",
    "DENIED",
    "EXPIRED",
    "PENDING",
}


def check_connection_state(value: str) -> ConnectionState:
    if value in CONNECTION_STATE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {CONNECTION_STATE_VALUES!r}")
