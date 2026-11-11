from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.created_mandate_state import CreatedMandateState, check_created_mandate_state

T = TypeVar("T", bound="CreatedMandate")


@_attrs_define
class CreatedMandate:
    """
    Attributes:
        id (str):
        mandate_hash (str):
        state (CreatedMandateState): `ACTIVE` at once when the mandate allows several merchants: each cart is then held
            on its own.
        open_mandate (None | str): The open mandate (L2) the TEE issued; the agent closes it per purchase.
    """

    id: str
    mandate_hash: str
    state: CreatedMandateState
    open_mandate: str | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        mandate_hash = self.mandate_hash

        state: str = self.state

        open_mandate: str | None
        open_mandate = self.open_mandate

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "mandateHash": mandate_hash,
                "state": state,
                "openMandate": open_mandate,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        mandate_hash = d.pop("mandateHash")

        state = check_created_mandate_state(d.pop("state"))

        def _parse_open_mandate(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        open_mandate = _parse_open_mandate(d.pop("openMandate"))

        created_mandate = cls(
            id=id,
            mandate_hash=mandate_hash,
            state=state,
            open_mandate=open_mandate,
        )

        created_mandate.additional_properties = d
        return created_mandate

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
