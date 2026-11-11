from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="WebFactWebFactWebFact")


@_attrs_define
class WebFactWebFactWebFact:
    """
    Attributes:
        host_hash (str):
        url_path_hash (str):
        t_capture (int):
        range_commitment (str):
        att_id (str):
    """

    host_hash: str
    url_path_hash: str
    t_capture: int
    range_commitment: str
    att_id: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        host_hash = self.host_hash

        url_path_hash = self.url_path_hash

        t_capture = self.t_capture

        range_commitment = self.range_commitment

        att_id = self.att_id

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "hostHash": host_hash,
                "urlPathHash": url_path_hash,
                "tCapture": t_capture,
                "rangeCommitment": range_commitment,
                "attId": att_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        host_hash = d.pop("hostHash")

        url_path_hash = d.pop("urlPathHash")

        t_capture = d.pop("tCapture")

        range_commitment = d.pop("rangeCommitment")

        att_id = d.pop("attId")

        web_fact_web_fact_web_fact = cls(
            host_hash=host_hash,
            url_path_hash=url_path_hash,
            t_capture=t_capture,
            range_commitment=range_commitment,
            att_id=att_id,
        )

        web_fact_web_fact_web_fact.additional_properties = d
        return web_fact_web_fact_web_fact

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
