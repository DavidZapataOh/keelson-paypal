from typing import Literal

GetStatusResponse200DependenciesDb = Literal["down", "up"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_DB_VALUES: set[GetStatusResponse200DependenciesDb] = {
    "down",
    "up",
}


def check_get_status_response_200_dependencies_db(value: str) -> GetStatusResponse200DependenciesDb:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_DB_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_DB_VALUES!r}"
    )
