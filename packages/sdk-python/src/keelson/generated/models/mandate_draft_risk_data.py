from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="MandateDraftRiskData")


@_attrs_define
class MandateDraftRiskData:
    """
    Attributes:
        device_fp (str):
        ip (str):
    """

    device_fp: str
    ip: str

    def to_dict(self) -> dict[str, Any]:
        device_fp = self.device_fp

        ip = self.ip

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "device_fp": device_fp,
                "ip": ip,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        device_fp = d.pop("device_fp")

        ip = d.pop("ip")

        mandate_draft_risk_data = cls(
            device_fp=device_fp,
            ip=ip,
        )

        return mandate_draft_risk_data
