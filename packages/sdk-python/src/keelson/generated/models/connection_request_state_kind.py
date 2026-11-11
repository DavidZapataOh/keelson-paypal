from typing import Literal

ConnectionRequestStateKind = Literal["change", "connect", "once"]

CONNECTION_REQUEST_STATE_KIND_VALUES: set[ConnectionRequestStateKind] = {
    "change",
    "connect",
    "once",
}


def check_connection_request_state_kind(value: str) -> ConnectionRequestStateKind:
    if value in CONNECTION_REQUEST_STATE_KIND_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CONNECTION_REQUEST_STATE_KIND_VALUES!r}"
    )
