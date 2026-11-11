from typing import Literal

GetHealthResponse200Status = Literal["ok"]

GET_HEALTH_RESPONSE_200_STATUS_VALUES: set[GetHealthResponse200Status] = {
    "ok",
}


def check_get_health_response_200_status(value: str) -> GetHealthResponse200Status:
    if value in GET_HEALTH_RESPONSE_200_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_HEALTH_RESPONSE_200_STATUS_VALUES!r}"
    )
