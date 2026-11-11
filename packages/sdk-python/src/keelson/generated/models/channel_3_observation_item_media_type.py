from typing import Literal

Channel3ObservationItemMediaType = Literal["application/json"]

CHANNEL_3_OBSERVATION_ITEM_MEDIA_TYPE_VALUES: set[Channel3ObservationItemMediaType] = {
    "application/json",
}


def check_channel_3_observation_item_media_type(value: str) -> Channel3ObservationItemMediaType:
    if value in CHANNEL_3_OBSERVATION_ITEM_MEDIA_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CHANNEL_3_OBSERVATION_ITEM_MEDIA_TYPE_VALUES!r}"
    )
