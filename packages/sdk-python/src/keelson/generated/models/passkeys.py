from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.passkeys_passkeys_item import PasskeysPasskeysItem


T = TypeVar("T", bound="Passkeys")


@_attrs_define
class Passkeys:
    """
    Attributes:
        passkeys (list[PasskeysPasskeysItem]):
    """

    passkeys: list[PasskeysPasskeysItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        passkeys = []
        for passkeys_item_data in self.passkeys:
            passkeys_item = passkeys_item_data.to_dict()
            passkeys.append(passkeys_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "passkeys": passkeys,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.passkeys_passkeys_item import PasskeysPasskeysItem

        d = dict(src_dict)
        passkeys = []
        _passkeys = d.pop("passkeys")
        for passkeys_item_data in _passkeys:
            passkeys_item = PasskeysPasskeysItem.from_dict(passkeys_item_data)

            passkeys.append(passkeys_item)

        passkeys = cls(
            passkeys=passkeys,
        )

        passkeys.additional_properties = d
        return passkeys

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
