from typing import Literal

MerchantDisputePaidByType2Type1 = Literal["chain", "treasury", "violation-pool"]

MERCHANT_DISPUTE_PAID_BY_TYPE_2_TYPE_1_VALUES: set[MerchantDisputePaidByType2Type1] = {
    "chain",
    "treasury",
    "violation-pool",
}


def check_merchant_dispute_paid_by_type_2_type_1(value: str) -> MerchantDisputePaidByType2Type1:
    if value in MERCHANT_DISPUTE_PAID_BY_TYPE_2_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_DISPUTE_PAID_BY_TYPE_2_TYPE_1_VALUES!r}"
    )
