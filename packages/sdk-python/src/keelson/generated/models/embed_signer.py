from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.embed_signer_passkeys_item import EmbedSignerPasskeysItem


T = TypeVar("T", bound="EmbedSigner")


@_attrs_define
class EmbedSigner:
    """
    Attributes:
        passkeys (list[EmbedSignerPasskeysItem]):
        credential_id (None | str):
    """

    passkeys: list[EmbedSignerPasskeysItem]
    credential_id: str | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        passkeys = []
        for passkeys_item_data in self.passkeys:
            passkeys_item = passkeys_item_data.to_dict()
            passkeys.append(passkeys_item)

        credential_id: str | None
        credential_id = self.credential_id

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "passkeys": passkeys,
                "credentialId": credential_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.embed_signer_passkeys_item import EmbedSignerPasskeysItem

        d = dict(src_dict)
        passkeys = []
        _passkeys = d.pop("passkeys")
        for passkeys_item_data in _passkeys:
            passkeys_item = EmbedSignerPasskeysItem.from_dict(passkeys_item_data)

            passkeys.append(passkeys_item)

        def _parse_credential_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        credential_id = _parse_credential_id(d.pop("credentialId"))

        embed_signer = cls(
            passkeys=passkeys,
            credential_id=credential_id,
        )

        embed_signer.additional_properties = d
        return embed_signer

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
