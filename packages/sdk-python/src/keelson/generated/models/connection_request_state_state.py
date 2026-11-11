from typing import Literal

ConnectionRequestStateState = Literal["APPROVED", "DENIED", "EXPIRED", "PENDING"]

CONNECTION_REQUEST_STATE_STATE_VALUES: set[ConnectionRequestStateState] = {
    "APPROVED",
    "DENIED",
    "EXPIRED",
    "PENDING",
}


def check_connection_request_state_state(value: str) -> ConnectionRequestStateState:
    if value in CONNECTION_REQUEST_STATE_STATE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CONNECTION_REQUEST_STATE_STATE_VALUES!r}"
    )
