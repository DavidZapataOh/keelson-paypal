from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

T = TypeVar("T", bound="MandateDraftPolicy")


@_attrs_define
class MandateDraftPolicy:
    """
    Attributes:
        engine (str):
        version (str):
        policy_set_hash (str):
        measurements (list[str]):
    """

    engine: str
    version: str
    policy_set_hash: str
    measurements: list[str]

    def to_dict(self) -> dict[str, Any]:
        engine = self.engine

        version = self.version

        policy_set_hash = self.policy_set_hash

        measurements = self.measurements

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "engine": engine,
                "version": version,
                "policy_set_hash": policy_set_hash,
                "measurements": measurements,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        engine = d.pop("engine")

        version = d.pop("version")

        policy_set_hash = d.pop("policy_set_hash")

        measurements = cast(list[str], d.pop("measurements"))

        mandate_draft_policy = cls(
            engine=engine,
            version=version,
            policy_set_hash=policy_set_hash,
            measurements=measurements,
        )

        return mandate_draft_policy
