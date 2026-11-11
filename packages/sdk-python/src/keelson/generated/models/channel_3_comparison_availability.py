from typing import Literal

Channel3ComparisonAvailability = Literal["match", "mismatch", "unknown"]

CHANNEL_3_COMPARISON_AVAILABILITY_VALUES: set[Channel3ComparisonAvailability] = {
    "match",
    "mismatch",
    "unknown",
}


def check_channel_3_comparison_availability(value: str) -> Channel3ComparisonAvailability:
    if value in CHANNEL_3_COMPARISON_AVAILABILITY_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CHANNEL_3_COMPARISON_AVAILABILITY_VALUES!r}"
    )
