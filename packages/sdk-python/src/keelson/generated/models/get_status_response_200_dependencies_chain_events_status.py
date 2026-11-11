from typing import Literal

GetStatusResponse200DependenciesChainEventsStatus = Literal["down", "up"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_CHAIN_EVENTS_STATUS_VALUES: set[
    GetStatusResponse200DependenciesChainEventsStatus
] = {
    "down",
    "up",
}


def check_get_status_response_200_dependencies_chain_events_status(
    value: str,
) -> GetStatusResponse200DependenciesChainEventsStatus:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_CHAIN_EVENTS_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_CHAIN_EVENTS_STATUS_VALUES!r}"
    )
