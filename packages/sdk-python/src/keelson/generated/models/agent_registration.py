from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.agent_registration_registrations_item import AgentRegistrationRegistrationsItem
    from ..models.agent_registration_services_item import AgentRegistrationServicesItem


T = TypeVar("T", bound="AgentRegistration")


@_attrs_define
class AgentRegistration:
    """An ERC-8004 agent registration file (`registration-v1`).

    Attributes:
        type_ (str):
        name (str):
        description (str):
        image (str):
        services (list[AgentRegistrationServicesItem]):
        x_402_support (bool):
        active (bool):
        registrations (list[AgentRegistrationRegistrationsItem]):
        supported_trust (list[str] | Unset):
    """

    type_: str
    name: str
    description: str
    image: str
    services: list[AgentRegistrationServicesItem]
    x_402_support: bool
    active: bool
    registrations: list[AgentRegistrationRegistrationsItem]
    supported_trust: list[str] | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_

        name = self.name

        description = self.description

        image = self.image

        services = []
        for services_item_data in self.services:
            services_item = services_item_data.to_dict()
            services.append(services_item)

        x_402_support = self.x_402_support

        active = self.active

        registrations = []
        for registrations_item_data in self.registrations:
            registrations_item = registrations_item_data.to_dict()
            registrations.append(registrations_item)

        supported_trust: list[str] | Unset = UNSET
        if not isinstance(self.supported_trust, Unset):
            supported_trust = self.supported_trust

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "type": type_,
                "name": name,
                "description": description,
                "image": image,
                "services": services,
                "x402Support": x_402_support,
                "active": active,
                "registrations": registrations,
            }
        )
        if supported_trust is not UNSET:
            field_dict["supportedTrust"] = supported_trust

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.agent_registration_registrations_item import (
            AgentRegistrationRegistrationsItem,
        )
        from ..models.agent_registration_services_item import AgentRegistrationServicesItem

        d = dict(src_dict)
        type_ = d.pop("type")

        name = d.pop("name")

        description = d.pop("description")

        image = d.pop("image")

        services = []
        _services = d.pop("services")
        for services_item_data in _services:
            services_item = AgentRegistrationServicesItem.from_dict(services_item_data)

            services.append(services_item)

        x_402_support = d.pop("x402Support")

        active = d.pop("active")

        registrations = []
        _registrations = d.pop("registrations")
        for registrations_item_data in _registrations:
            registrations_item = AgentRegistrationRegistrationsItem.from_dict(
                registrations_item_data
            )

            registrations.append(registrations_item)

        supported_trust = cast(list[str], d.pop("supportedTrust", UNSET))

        agent_registration = cls(
            type_=type_,
            name=name,
            description=description,
            image=image,
            services=services,
            x_402_support=x_402_support,
            active=active,
            registrations=registrations,
            supported_trust=supported_trust,
        )

        agent_registration.additional_properties = d
        return agent_registration

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
