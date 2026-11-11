from typing import Literal

GetStatusResponse200Status = Literal["degraded", "ok"]

GET_STATUS_RESPONSE_200_STATUS_VALUES: set[GetStatusResponse200Status] = {
    "degraded",
    "ok",
}


def check_get_status_response_200_status(value: str) -> GetStatusResponse200Status:
    if value in GET_STATUS_RESPONSE_200_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_STATUS_VALUES!r}"
    )
