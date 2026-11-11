from typing import Literal

Channel3ComparisonPrice = Literal["match", "mismatch", "unknown"]

CHANNEL_3_COMPARISON_PRICE_VALUES: set[Channel3ComparisonPrice] = {
    "match",
    "mismatch",
    "unknown",
}


def check_channel_3_comparison_price(value: str) -> Channel3ComparisonPrice:
    if value in CHANNEL_3_COMPARISON_PRICE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CHANNEL_3_COMPARISON_PRICE_VALUES!r}"
    )
