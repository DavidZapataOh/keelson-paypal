from typing import Literal

MerchantDisputeLiableType1 = Literal["keelson", "merchant", "operator", "user"]

MERCHANT_DISPUTE_LIABLE_TYPE_1_VALUES: set[MerchantDisputeLiableType1] = {
    "keelson",
    "merchant",
    "operator",
    "user",
}


def check_merchant_dispute_liable_type_1(value: str) -> MerchantDisputeLiableType1:
    if value in MERCHANT_DISPUTE_LIABLE_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_DISPUTE_LIABLE_TYPE_1_VALUES!r}"
    )
