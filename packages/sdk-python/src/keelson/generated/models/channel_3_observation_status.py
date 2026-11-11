from typing import Literal

Channel3ObservationStatus = Literal["ok", "unavailable"]

CHANNEL_3_OBSERVATION_STATUS_VALUES: set[Channel3ObservationStatus] = {
    "ok",
    "unavailable",
}


def check_channel_3_observation_status(value: str) -> Channel3ObservationStatus:
    if value in CHANNEL_3_OBSERVATION_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CHANNEL_3_OBSERVATION_STATUS_VALUES!r}"
    )
