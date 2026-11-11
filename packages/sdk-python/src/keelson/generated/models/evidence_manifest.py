from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.evidence_manifest_v import EvidenceManifestV, check_evidence_manifest_v

if TYPE_CHECKING:
    from ..models.evidence_manifest_items_item import EvidenceManifestItemsItem


T = TypeVar("T", bound="EvidenceManifest")


@_attrs_define
class EvidenceManifest:
    """Type, media type and salted leaf of every item, in order; `root` is the RFC 6962 tree hash of the leaves and the
    `evidenceRoot`. Content hashes and salts are only given in a disclosure.

        Attributes:
            v (EvidenceManifestV):
            root (str):
            items (list[EvidenceManifestItemsItem]):
    """

    v: EvidenceManifestV
    root: str
    items: list[EvidenceManifestItemsItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        v: str = self.v

        root = self.root

        items = []
        for items_item_data in self.items:
            items_item = items_item_data.to_dict()
            items.append(items_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "v": v,
                "root": root,
                "items": items,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.evidence_manifest_items_item import EvidenceManifestItemsItem

        d = dict(src_dict)
        v = check_evidence_manifest_v(d.pop("v"))

        root = d.pop("root")

        items = []
        _items = d.pop("items")
        for items_item_data in _items:
            items_item = EvidenceManifestItemsItem.from_dict(items_item_data)

            items.append(items_item)

        evidence_manifest = cls(
            v=v,
            root=root,
            items=items,
        )

        evidence_manifest.additional_properties = d
        return evidence_manifest

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
