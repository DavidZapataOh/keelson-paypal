from typing import Literal

ConnectionKind = Literal["change", "connect", "once"]

CONNECTION_KIND_VALUES: set[ConnectionKind] = {
    "change",
    "connect",
    "once",
}


def check_connection_kind(value: str) -> ConnectionKind:
    if value in CONNECTION_KIND_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {CONNECTION_KIND_VALUES!r}")
