from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.alibi_receipt_anchor import AlibiReceiptAnchor
    from ..models.alibi_receipt_timestamps_item import AlibiReceiptTimestampsItem


T = TypeVar("T", bound="AlibiReceipt")


@_attrs_define
class AlibiReceipt:
    """
    Attributes:
        alibi_id (str):
        leaf (str): The leaf bytes, base64.
        leaf_hash (str): The RFC 6962 leaf hash, unpadded base64url.
        tlog_proof (str): A c2sp.org/tlog-proof@v1 with cosignatures.
        timestamps (list[AlibiReceiptTimestampsItem]):
        anchor (AlibiReceiptAnchor | Unset):
    """

    alibi_id: str
    leaf: str
    leaf_hash: str
    tlog_proof: str
    timestamps: list[AlibiReceiptTimestampsItem]
    anchor: AlibiReceiptAnchor | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        alibi_id = self.alibi_id

        leaf = self.leaf

        leaf_hash = self.leaf_hash

        tlog_proof = self.tlog_proof

        timestamps = []
        for timestamps_item_data in self.timestamps:
            timestamps_item = timestamps_item_data.to_dict()
            timestamps.append(timestamps_item)

        anchor: dict[str, Any] | Unset = UNSET
        if not isinstance(self.anchor, Unset):
            anchor = self.anchor.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "alibi_id": alibi_id,
                "leaf": leaf,
                "leaf_hash": leaf_hash,
                "tlog_proof": tlog_proof,
                "timestamps": timestamps,
            }
        )
        if anchor is not UNSET:
            field_dict["anchor"] = anchor

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.alibi_receipt_anchor import AlibiReceiptAnchor
        from ..models.alibi_receipt_timestamps_item import AlibiReceiptTimestampsItem

        d = dict(src_dict)
        alibi_id = d.pop("alibi_id")

        leaf = d.pop("leaf")

        leaf_hash = d.pop("leaf_hash")

        tlog_proof = d.pop("tlog_proof")

        timestamps = []
        _timestamps = d.pop("timestamps")
        for timestamps_item_data in _timestamps:
            timestamps_item = AlibiReceiptTimestampsItem.from_dict(timestamps_item_data)

            timestamps.append(timestamps_item)

        _anchor = d.pop("anchor", UNSET)
        anchor: AlibiReceiptAnchor | Unset
        if isinstance(_anchor, Unset):
            anchor = UNSET
        else:
            anchor = AlibiReceiptAnchor.from_dict(_anchor)

        alibi_receipt = cls(
            alibi_id=alibi_id,
            leaf=leaf,
            leaf_hash=leaf_hash,
            tlog_proof=tlog_proof,
            timestamps=timestamps,
            anchor=anchor,
        )

        alibi_receipt.additional_properties = d
        return alibi_receipt

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
