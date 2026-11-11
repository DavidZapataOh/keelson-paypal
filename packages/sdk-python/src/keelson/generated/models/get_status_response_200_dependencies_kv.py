from typing import Literal

GetStatusResponse200DependenciesKv = Literal["down", "up"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_KV_VALUES: set[GetStatusResponse200DependenciesKv] = {
    "down",
    "up",
}


def check_get_status_response_200_dependencies_kv(value: str) -> GetStatusResponse200DependenciesKv:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_KV_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_KV_VALUES!r}"
    )
