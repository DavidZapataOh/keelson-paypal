from typing import Literal

TimestampTsa = Literal["digicert", "freetsa", "sectigo", "sigstore"]

TIMESTAMP_TSA_VALUES: set[TimestampTsa] = {
    "digicert",
    "freetsa",
    "sectigo",
    "sigstore",
}


def check_timestamp_tsa(value: str) -> TimestampTsa:
    if value in TIMESTAMP_TSA_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {TIMESTAMP_TSA_VALUES!r}")
