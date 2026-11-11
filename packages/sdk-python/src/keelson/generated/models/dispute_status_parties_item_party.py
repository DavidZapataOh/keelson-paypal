from typing import Literal

DisputeStatusPartiesItemParty = Literal["keelson", "merchant", "operator"]

DISPUTE_STATUS_PARTIES_ITEM_PARTY_VALUES: set[DisputeStatusPartiesItemParty] = {
    "keelson",
    "merchant",
    "operator",
}


def check_dispute_status_parties_item_party(value: str) -> DisputeStatusPartiesItemParty:
    if value in DISPUTE_STATUS_PARTIES_ITEM_PARTY_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DISPUTE_STATUS_PARTIES_ITEM_PARTY_VALUES!r}"
    )
