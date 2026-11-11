from typing import Literal

GetStatusResponse200DependenciesRelayerStatus = Literal["degraded", "down", "up"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_RELAYER_STATUS_VALUES: set[
    GetStatusResponse200DependenciesRelayerStatus
] = {
    "degraded",
    "down",
    "up",
}


def check_get_status_response_200_dependencies_relayer_status(
    value: str,
) -> GetStatusResponse200DependenciesRelayerStatus:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_RELAYER_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_RELAYER_STATUS_VALUES!r}"
    )
