from typing import Literal

Channel3ComparisonBrand = Literal["match", "mismatch", "unknown"]

CHANNEL_3_COMPARISON_BRAND_VALUES: set[Channel3ComparisonBrand] = {
    "match",
    "mismatch",
    "unknown",
}


def check_channel_3_comparison_brand(value: str) -> Channel3ComparisonBrand:
    if value in CHANNEL_3_COMPARISON_BRAND_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CHANNEL_3_COMPARISON_BRAND_VALUES!r}"
    )
