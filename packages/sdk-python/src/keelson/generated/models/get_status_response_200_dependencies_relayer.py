from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.get_status_response_200_dependencies_relayer_status import (
    GetStatusResponse200DependenciesRelayerStatus,
    check_get_status_response_200_dependencies_relayer_status,
)

if TYPE_CHECKING:
    from ..models.get_status_response_200_dependencies_relayer_chains_item import (
        GetStatusResponse200DependenciesRelayerChainsItem,
    )


T = TypeVar("T", bound="GetStatusResponse200DependenciesRelayer")


@_attrs_define
class GetStatusResponse200DependenciesRelayer:
    """
    Attributes:
        status (GetStatusResponse200DependenciesRelayerStatus):
        chains (list[GetStatusResponse200DependenciesRelayerChainsItem]):
    """

    status: GetStatusResponse200DependenciesRelayerStatus
    chains: list[GetStatusResponse200DependenciesRelayerChainsItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        status: str = self.status

        chains = []
        for chains_item_data in self.chains:
            chains_item = chains_item_data.to_dict()
            chains.append(chains_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "status": status,
                "chains": chains,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.get_status_response_200_dependencies_relayer_chains_item import (
            GetStatusResponse200DependenciesRelayerChainsItem,
        )

        d = dict(src_dict)
        status = check_get_status_response_200_dependencies_relayer_status(d.pop("status"))

        chains = []
        _chains = d.pop("chains")
        for chains_item_data in _chains:
            chains_item = GetStatusResponse200DependenciesRelayerChainsItem.from_dict(
                chains_item_data
            )

            chains.append(chains_item)

        get_status_response_200_dependencies_relayer = cls(
            status=status,
            chains=chains,
        )

        get_status_response_200_dependencies_relayer.additional_properties = d
        return get_status_response_200_dependencies_relayer

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
