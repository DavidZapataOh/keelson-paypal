from typing import Literal

GetStatusResponse200DependenciesLogStatus = Literal["down", "up"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_LOG_STATUS_VALUES: set[
    GetStatusResponse200DependenciesLogStatus
] = {
    "down",
    "up",
}


def check_get_status_response_200_dependencies_log_status(
    value: str,
) -> GetStatusResponse200DependenciesLogStatus:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_LOG_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_LOG_STATUS_VALUES!r}"
    )
