from typing import Literal

MandateSummaryHoldMode = Literal["mandate", "per_purchase"]

MANDATE_SUMMARY_HOLD_MODE_VALUES: set[MandateSummaryHoldMode] = {
    "mandate",
    "per_purchase",
}


def check_mandate_summary_hold_mode(value: str) -> MandateSummaryHoldMode:
    if value in MANDATE_SUMMARY_HOLD_MODE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_SUMMARY_HOLD_MODE_VALUES!r}"
    )
