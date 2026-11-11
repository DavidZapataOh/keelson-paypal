from typing import Literal

TransactionStatus = Literal["confirmed", "dropped", "pending", "rejected", "reverted"]

TRANSACTION_STATUS_VALUES: set[TransactionStatus] = {
    "confirmed",
    "dropped",
    "pending",
    "rejected",
    "reverted",
}


def check_transaction_status(value: str) -> TransactionStatus:
    if value in TRANSACTION_STATUS_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {TRANSACTION_STATUS_VALUES!r}")
