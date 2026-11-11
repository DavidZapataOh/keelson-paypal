from typing import Literal

GetStatusResponse200DependenciesWebhooksStatus = Literal["down", "up"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_WEBHOOKS_STATUS_VALUES: set[
    GetStatusResponse200DependenciesWebhooksStatus
] = {
    "down",
    "up",
}


def check_get_status_response_200_dependencies_webhooks_status(
    value: str,
) -> GetStatusResponse200DependenciesWebhooksStatus:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_WEBHOOKS_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_WEBHOOKS_STATUS_VALUES!r}"
    )
