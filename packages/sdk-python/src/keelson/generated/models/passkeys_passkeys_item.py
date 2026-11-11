from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="PasskeysPasskeysItem")


@_attrs_define
class PasskeysPasskeysItem:
    """
    Attributes:
        id (str):
        credential_id (str):
        name (None | str):
        created_at (datetime.datetime | None):
        payment (bool): Registered with the SPC `payment` extension, so SPC can use it.
    """

    id: str
    credential_id: str
    name: str | None
    created_at: datetime.datetime | None
    payment: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        credential_id = self.credential_id

        name: str | None
        name = self.name

        created_at: str | None
        if isinstance(self.created_at, datetime.datetime):
            created_at = self.created_at.isoformat()
        else:
            created_at = self.created_at

        payment = self.payment

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "credentialId": credential_id,
                "name": name,
                "createdAt": created_at,
                "payment": payment,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        credential_id = d.pop("credentialId")

        def _parse_name(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        name = _parse_name(d.pop("name"))

        def _parse_created_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                created_at_type_0 = datetime.datetime.fromisoformat(data)

                return created_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        created_at = _parse_created_at(d.pop("createdAt"))

        payment = d.pop("payment")

        passkeys_passkeys_item = cls(
            id=id,
            credential_id=credential_id,
            name=name,
            created_at=created_at,
            payment=payment,
        )

        passkeys_passkeys_item.additional_properties = d
        return passkeys_passkeys_item

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
