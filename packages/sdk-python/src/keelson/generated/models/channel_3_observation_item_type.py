from typing import Literal

Channel3ObservationItemType = Literal["channel3.observation"]

CHANNEL_3_OBSERVATION_ITEM_TYPE_VALUES: set[Channel3ObservationItemType] = {
    "channel3.observation",
}


def check_channel_3_observation_item_type(value: str) -> Channel3ObservationItemType:
    if value in CHANNEL_3_OBSERVATION_ITEM_TYPE_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CHANNEL_3_OBSERVATION_ITEM_TYPE_VALUES!r}"
    )
