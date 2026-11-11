from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.mandate_draft_user_cred_jwk import MandateDraftUserCredJwk


T = TypeVar("T", bound="MandateDraftUserCred")


@_attrs_define
class MandateDraftUserCred:
    """
    Attributes:
        id (str):
        rp_id (str):
        jwk (MandateDraftUserCredJwk):
    """

    id: str
    rp_id: str
    jwk: MandateDraftUserCredJwk

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        rp_id = self.rp_id

        jwk = self.jwk.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "id": id,
                "rp_id": rp_id,
                "jwk": jwk,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_draft_user_cred_jwk import MandateDraftUserCredJwk

        d = dict(src_dict)
        id = d.pop("id")

        rp_id = d.pop("rp_id")

        jwk = MandateDraftUserCredJwk.from_dict(d.pop("jwk"))

        mandate_draft_user_cred = cls(
            id=id,
            rp_id=rp_id,
            jwk=jwk,
        )

        return mandate_draft_user_cred
