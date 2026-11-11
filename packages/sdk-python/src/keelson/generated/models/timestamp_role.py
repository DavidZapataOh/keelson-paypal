from typing import Literal

TimestampRole = Literal["fallback", "primary"]

TIMESTAMP_ROLE_VALUES: set[TimestampRole] = {
    "fallback",
    "primary",
}


def check_timestamp_role(value: str) -> TimestampRole:
    if value in TIMESTAMP_ROLE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {TIMESTAMP_ROLE_VALUES!r}")
