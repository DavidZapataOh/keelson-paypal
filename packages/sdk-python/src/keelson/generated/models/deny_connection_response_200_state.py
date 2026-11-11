from typing import Literal

DenyConnectionResponse200State = Literal["DENIED"]

DENY_CONNECTION_RESPONSE_200_STATE_VALUES: set[DenyConnectionResponse200State] = {
    "DENIED",
}


def check_deny_connection_response_200_state(value: str) -> DenyConnectionResponse200State:
    if value in DENY_CONNECTION_RESPONSE_200_STATE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DENY_CONNECTION_RESPONSE_200_STATE_VALUES!r}"
    )
