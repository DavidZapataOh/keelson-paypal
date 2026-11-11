from typing import Literal

GetStatusResponse200DependenciesRelayerChainsItemStatus = Literal["degraded", "down", "up"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_RELAYER_CHAINS_ITEM_STATUS_VALUES: set[
    GetStatusResponse200DependenciesRelayerChainsItemStatus
] = {
    "degraded",
    "down",
    "up",
}


def check_get_status_response_200_dependencies_relayer_chains_item_status(
    value: str,
) -> GetStatusResponse200DependenciesRelayerChainsItemStatus:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_RELAYER_CHAINS_ITEM_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_RELAYER_CHAINS_ITEM_STATUS_VALUES!r}"
    )
