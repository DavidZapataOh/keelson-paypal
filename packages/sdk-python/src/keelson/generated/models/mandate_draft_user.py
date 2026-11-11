from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.mandate_draft_user_cred import MandateDraftUserCred


T = TypeVar("T", bound="MandateDraftUser")


@_attrs_define
class MandateDraftUser:
    """
    Attributes:
        sub (str):
        cred (MandateDraftUserCred):
        app_login_id (str):
    """

    sub: str
    cred: MandateDraftUserCred
    app_login_id: str

    def to_dict(self) -> dict[str, Any]:
        sub = self.sub

        cred = self.cred.to_dict()

        app_login_id = self.app_login_id

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "sub": sub,
                "cred": cred,
                "app_login_id": app_login_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_draft_user_cred import MandateDraftUserCred

        d = dict(src_dict)
        sub = d.pop("sub")

        cred = MandateDraftUserCred.from_dict(d.pop("cred"))

        app_login_id = d.pop("app_login_id")

        mandate_draft_user = cls(
            sub=sub,
            cred=cred,
            app_login_id=app_login_id,
        )

        return mandate_draft_user
