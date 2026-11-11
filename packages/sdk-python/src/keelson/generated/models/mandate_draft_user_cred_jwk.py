from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_user_cred_jwk_crv import (
    MandateDraftUserCredJwkCrv,
    check_mandate_draft_user_cred_jwk_crv,
)
from ..models.mandate_draft_user_cred_jwk_kty import (
    MandateDraftUserCredJwkKty,
    check_mandate_draft_user_cred_jwk_kty,
)

T = TypeVar("T", bound="MandateDraftUserCredJwk")


@_attrs_define
class MandateDraftUserCredJwk:
    """
    Attributes:
        kty (MandateDraftUserCredJwkKty):
        crv (MandateDraftUserCredJwkCrv):
        x (str):
        y (str):
    """

    kty: MandateDraftUserCredJwkKty
    crv: MandateDraftUserCredJwkCrv
    x: str
    y: str

    def to_dict(self) -> dict[str, Any]:
        kty: str = self.kty

        crv: str = self.crv

        x = self.x

        y = self.y

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "kty": kty,
                "crv": crv,
                "x": x,
                "y": y,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        kty = check_mandate_draft_user_cred_jwk_kty(d.pop("kty"))

        crv = check_mandate_draft_user_cred_jwk_crv(d.pop("crv"))

        x = d.pop("x")

        y = d.pop("y")

        mandate_draft_user_cred_jwk = cls(
            kty=kty,
            crv=crv,
            x=x,
            y=y,
        )

        return mandate_draft_user_cred_jwk
