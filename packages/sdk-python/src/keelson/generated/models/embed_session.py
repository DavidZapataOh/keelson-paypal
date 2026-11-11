from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.embed_request import EmbedRequest


T = TypeVar("T", bound="EmbedSession")


@_attrs_define
class EmbedSession:
    """
    Attributes:
        session (str):
        embed (EmbedRequest):
    """

    session: str
    embed: EmbedRequest
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        session = self.session

        embed = self.embed.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "session": session,
                "embed": embed,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.embed_request import EmbedRequest

        d = dict(src_dict)
        session = d.pop("session")

        embed = EmbedRequest.from_dict(d.pop("embed"))

        embed_session = cls(
            session=session,
            embed=embed,
        )

        embed_session.additional_properties = d
        return embed_session

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
