from typing import Literal

GetStatusResponse200DependenciesAnchorEnvironment = Literal["arbitrum-sepolia"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_ANCHOR_ENVIRONMENT_VALUES: set[
    GetStatusResponse200DependenciesAnchorEnvironment
] = {
    "arbitrum-sepolia",
}


def check_get_status_response_200_dependencies_anchor_environment(
    value: str,
) -> GetStatusResponse200DependenciesAnchorEnvironment:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_ANCHOR_ENVIRONMENT_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_ANCHOR_ENVIRONMENT_VALUES!r}"
    )
