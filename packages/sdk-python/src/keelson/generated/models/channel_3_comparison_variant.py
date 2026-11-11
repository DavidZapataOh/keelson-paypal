from typing import Literal

Channel3ComparisonVariant = Literal["match", "mismatch", "unknown"]

CHANNEL_3_COMPARISON_VARIANT_VALUES: set[Channel3ComparisonVariant] = {
    "match",
    "mismatch",
    "unknown",
}


def check_channel_3_comparison_variant(value: str) -> Channel3ComparisonVariant:
    if value in CHANNEL_3_COMPARISON_VARIANT_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CHANNEL_3_COMPARISON_VARIANT_VALUES!r}"
    )
