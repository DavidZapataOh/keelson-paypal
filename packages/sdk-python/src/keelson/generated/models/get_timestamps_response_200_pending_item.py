from typing import Literal

GetTimestampsResponse200PendingItem = Literal["digicert", "freetsa", "sectigo", "sigstore"]

GET_TIMESTAMPS_RESPONSE_200_PENDING_ITEM_VALUES: set[GetTimestampsResponse200PendingItem] = {
    "digicert",
    "freetsa",
    "sectigo",
    "sigstore",
}


def check_get_timestamps_response_200_pending_item(
    value: str,
) -> GetTimestampsResponse200PendingItem:
    if value in GET_TIMESTAMPS_RESPONSE_200_PENDING_ITEM_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_TIMESTAMPS_RESPONSE_200_PENDING_ITEM_VALUES!r}"
    )
