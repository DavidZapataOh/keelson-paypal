from typing import Literal

DisputeStatusSettlementOutcomeType2Type1 = Literal["claimable", "failed", "paid", "queued"]

DISPUTE_STATUS_SETTLEMENT_OUTCOME_TYPE_2_TYPE_1_VALUES: set[
    DisputeStatusSettlementOutcomeType2Type1
] = {
    "claimable",
    "failed",
    "paid",
    "queued",
}


def check_dispute_status_settlement_outcome_type_2_type_1(
    value: str,
) -> DisputeStatusSettlementOutcomeType2Type1:
    if value in DISPUTE_STATUS_SETTLEMENT_OUTCOME_TYPE_2_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DISPUTE_STATUS_SETTLEMENT_OUTCOME_TYPE_2_TYPE_1_VALUES!r}"
    )
