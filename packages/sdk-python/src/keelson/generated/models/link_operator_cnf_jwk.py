from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.link_operator_cnf_jwk_crv import (
    LinkOperatorCnfJwkCrv,
    check_link_operator_cnf_jwk_crv,
)
from ..models.link_operator_cnf_jwk_kty import (
    LinkOperatorCnfJwkKty,
    check_link_operator_cnf_jwk_kty,
)
from ..types import UNSET, Unset

T = TypeVar("T", bound="LinkOperatorCnfJwk")


@_attrs_define
class LinkOperatorCnfJwk:
    """The agent's P-256 `cnf` key, a public JWK.

    Attributes:
        kty (LinkOperatorCnfJwkKty):
        crv (LinkOperatorCnfJwkCrv):
        x (str):
        y (str):
        kid (str | Unset):
    """

    kty: LinkOperatorCnfJwkKty
    crv: LinkOperatorCnfJwkCrv
    x: str
    y: str
    kid: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        kty: str = self.kty

        crv: str = self.crv

        x = self.x

        y = self.y

        kid = self.kid

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "kty": kty,
                "crv": crv,
                "x": x,
                "y": y,
            }
        )
        if kid is not UNSET:
            field_dict["kid"] = kid

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        kty = check_link_operator_cnf_jwk_kty(d.pop("kty"))

        crv = check_link_operator_cnf_jwk_crv(d.pop("crv"))

        x = d.pop("x")

        y = d.pop("y")

        kid = d.pop("kid", UNSET)

        link_operator_cnf_jwk = cls(
            kty=kty,
            crv=crv,
            x=x,
            y=y,
            kid=kid,
        )

        link_operator_cnf_jwk.additional_properties = d
        return link_operator_cnf_jwk

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
