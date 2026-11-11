from typing import Literal

MerchantOrderDisputeState = Literal["ATTRIBUTED", "OPEN", "RESOLVED"]

MERCHANT_ORDER_DISPUTE_STATE_VALUES: set[MerchantOrderDisputeState] = {
    "ATTRIBUTED",
    "OPEN",
    "RESOLVED",
}


def check_merchant_order_dispute_state(value: str) -> MerchantOrderDisputeState:
    if value in MERCHANT_ORDER_DISPUTE_STATE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_ORDER_DISPUTE_STATE_VALUES!r}"
    )
