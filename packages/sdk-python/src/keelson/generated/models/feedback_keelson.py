from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="FeedbackKeelson")


@_attrs_define
class FeedbackKeelson:
    """
    Attributes:
        coverage_id (str):
        tx_hash (str):
    """

    coverage_id: str
    tx_hash: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        coverage_id = self.coverage_id

        tx_hash = self.tx_hash

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "coverageId": coverage_id,
                "txHash": tx_hash,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        coverage_id = d.pop("coverageId")

        tx_hash = d.pop("txHash")

        feedback_keelson = cls(
            coverage_id=coverage_id,
            tx_hash=tx_hash,
        )

        feedback_keelson.additional_properties = d
        return feedback_keelson

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
