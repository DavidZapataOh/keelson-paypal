from typing import Literal

LivePurchaseDecision = Literal["allow", "deny"]

LIVE_PURCHASE_DECISION_VALUES: set[LivePurchaseDecision] = {
    "allow",
    "deny",
}


def check_live_purchase_decision(value: str) -> LivePurchaseDecision:
    if value in LIVE_PURCHASE_DECISION_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {LIVE_PURCHASE_DECISION_VALUES!r}"
    )
