from typing import Literal

ConnectionApprovedKind = Literal["connect", "once"]

CONNECTION_APPROVED_KIND_VALUES: set[ConnectionApprovedKind] = {
    "connect",
    "once",
}


def check_connection_approved_kind(value: str) -> ConnectionApprovedKind:
    if value in CONNECTION_APPROVED_KIND_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CONNECTION_APPROVED_KIND_VALUES!r}"
    )
