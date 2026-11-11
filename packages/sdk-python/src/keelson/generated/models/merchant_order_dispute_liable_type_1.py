from typing import Literal

MerchantOrderDisputeLiableType1 = Literal["keelson", "merchant", "operator", "user"]

MERCHANT_ORDER_DISPUTE_LIABLE_TYPE_1_VALUES: set[MerchantOrderDisputeLiableType1] = {
    "keelson",
    "merchant",
    "operator",
    "user",
}


def check_merchant_order_dispute_liable_type_1(value: str) -> MerchantOrderDisputeLiableType1:
    if value in MERCHANT_ORDER_DISPUTE_LIABLE_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_ORDER_DISPUTE_LIABLE_TYPE_1_VALUES!r}"
    )
