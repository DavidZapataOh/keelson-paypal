from typing import Literal

CardChargebackReason = Literal["not_as_described", "not_received", "unauthorized"]

CARD_CHARGEBACK_REASON_VALUES: set[CardChargebackReason] = {
    "not_as_described",
    "not_received",
    "unauthorized",
}


def check_card_chargeback_reason(value: str) -> CardChargebackReason:
    if value in CARD_CHARGEBACK_REASON_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CARD_CHARGEBACK_REASON_VALUES!r}"
    )
