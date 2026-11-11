from typing import Literal

DisputeStatusLiableType2Type1 = Literal["keelson", "merchant", "operator", "user"]

DISPUTE_STATUS_LIABLE_TYPE_2_TYPE_1_VALUES: set[DisputeStatusLiableType2Type1] = {
    "keelson",
    "merchant",
    "operator",
    "user",
}


def check_dispute_status_liable_type_2_type_1(value: str) -> DisputeStatusLiableType2Type1:
    if value in DISPUTE_STATUS_LIABLE_TYPE_2_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DISPUTE_STATUS_LIABLE_TYPE_2_TYPE_1_VALUES!r}"
    )
