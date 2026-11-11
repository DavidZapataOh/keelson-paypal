from typing import Literal

MerchantDisputeState = Literal["ATTRIBUTED", "OPEN", "RESOLVED"]

MERCHANT_DISPUTE_STATE_VALUES: set[MerchantDisputeState] = {
    "ATTRIBUTED",
    "OPEN",
    "RESOLVED",
}


def check_merchant_dispute_state(value: str) -> MerchantDisputeState:
    if value in MERCHANT_DISPUTE_STATE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_DISPUTE_STATE_VALUES!r}"
    )
