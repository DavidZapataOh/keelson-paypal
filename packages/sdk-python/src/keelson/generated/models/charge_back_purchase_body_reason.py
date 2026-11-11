from typing import Literal

ChargeBackPurchaseBodyReason = Literal["not_as_described", "not_received", "unauthorized"]

CHARGE_BACK_PURCHASE_BODY_REASON_VALUES: set[ChargeBackPurchaseBodyReason] = {
    "not_as_described",
    "not_received",
    "unauthorized",
}


def check_charge_back_purchase_body_reason(value: str) -> ChargeBackPurchaseBodyReason:
    if value in CHARGE_BACK_PURCHASE_BODY_REASON_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CHARGE_BACK_PURCHASE_BODY_REASON_VALUES!r}"
    )
