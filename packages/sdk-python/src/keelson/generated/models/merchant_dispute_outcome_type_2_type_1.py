from typing import Literal

MerchantDisputeOutcomeType2Type1 = Literal["claimable", "failed", "paid", "queued"]

MERCHANT_DISPUTE_OUTCOME_TYPE_2_TYPE_1_VALUES: set[MerchantDisputeOutcomeType2Type1] = {
    "claimable",
    "failed",
    "paid",
    "queued",
}


def check_merchant_dispute_outcome_type_2_type_1(value: str) -> MerchantDisputeOutcomeType2Type1:
    if value in MERCHANT_DISPUTE_OUTCOME_TYPE_2_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_DISPUTE_OUTCOME_TYPE_2_TYPE_1_VALUES!r}"
    )
