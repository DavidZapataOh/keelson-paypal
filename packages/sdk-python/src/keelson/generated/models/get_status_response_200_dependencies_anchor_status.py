from typing import Literal

GetStatusResponse200DependenciesAnchorStatus = Literal["down", "up"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_ANCHOR_STATUS_VALUES: set[
    GetStatusResponse200DependenciesAnchorStatus
] = {
    "down",
    "up",
}


def check_get_status_response_200_dependencies_anchor_status(
    value: str,
) -> GetStatusResponse200DependenciesAnchorStatus:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_ANCHOR_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_ANCHOR_STATUS_VALUES!r}"
    )
