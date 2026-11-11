from typing import Literal

MerchantDisputePaidByType3Type1 = Literal["chain", "treasury", "violation-pool"]

MERCHANT_DISPUTE_PAID_BY_TYPE_3_TYPE_1_VALUES: set[MerchantDisputePaidByType3Type1] = {
    "chain",
    "treasury",
    "violation-pool",
}


def check_merchant_dispute_paid_by_type_3_type_1(value: str) -> MerchantDisputePaidByType3Type1:
    if value in MERCHANT_DISPUTE_PAID_BY_TYPE_3_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_DISPUTE_PAID_BY_TYPE_3_TYPE_1_VALUES!r}"
    )
