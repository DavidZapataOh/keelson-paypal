from typing import Literal

MerchantDisputeOutcomeType1 = Literal["claimable", "failed", "paid", "queued"]

MERCHANT_DISPUTE_OUTCOME_TYPE_1_VALUES: set[MerchantDisputeOutcomeType1] = {
    "claimable",
    "failed",
    "paid",
    "queued",
}


def check_merchant_dispute_outcome_type_1(value: str) -> MerchantDisputeOutcomeType1:
    if value in MERCHANT_DISPUTE_OUTCOME_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_DISPUTE_OUTCOME_TYPE_1_VALUES!r}"
    )
