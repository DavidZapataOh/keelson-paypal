from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.connection import Connection
    from ..models.embed_signer import EmbedSigner


T = TypeVar("T", bound="EmbedRequest")


@_attrs_define
class EmbedRequest:
    """
    Attributes:
        ref (str):
        origin (str):
        request (Connection):
        signer (EmbedSigner | None):
        match_number (int | None):
    """

    ref: str
    origin: str
    request: Connection
    signer: EmbedSigner | None
    match_number: int | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.embed_signer import EmbedSigner

        ref = self.ref

        origin = self.origin

        request = self.request.to_dict()

        signer: dict[str, Any] | None
        if isinstance(self.signer, EmbedSigner):
            signer = self.signer.to_dict()
        else:
            signer = self.signer

        match_number: int | None
        match_number = self.match_number

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "ref": ref,
                "origin": origin,
                "request": request,
                "signer": signer,
                "matchNumber": match_number,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.connection import Connection
        from ..models.embed_signer import EmbedSigner

        d = dict(src_dict)
        ref = d.pop("ref")

        origin = d.pop("origin")

        request = Connection.from_dict(d.pop("request"))

        def _parse_signer(data: object) -> EmbedSigner | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                signer_type_0 = EmbedSigner.from_dict(data)

                return signer_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(EmbedSigner | None, data)

        signer = _parse_signer(d.pop("signer"))

        def _parse_match_number(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        match_number = _parse_match_number(d.pop("matchNumber"))

        embed_request = cls(
            ref=ref,
            origin=origin,
            request=request,
            signer=signer,
            match_number=match_number,
        )

        embed_request.additional_properties = d
        return embed_request

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
