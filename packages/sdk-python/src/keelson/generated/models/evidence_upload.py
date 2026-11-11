from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.evidence_manifest import EvidenceManifest
    from ..models.evidence_upload_items_item import EvidenceUploadItemsItem


T = TypeVar("T", bound="EvidenceUpload")


@_attrs_define
class EvidenceUpload:
    """
    Attributes:
        mandate_id (str):
        manifest (EvidenceManifest): Type, media type and salted leaf of every item, in order; `root` is the RFC 6962
            tree hash of the leaves and the `evidenceRoot`. Content hashes and salts are only given in a disclosure.
        items (list[EvidenceUploadItemsItem]):
    """

    mandate_id: str
    manifest: EvidenceManifest
    items: list[EvidenceUploadItemsItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        mandate_id = self.mandate_id

        manifest = self.manifest.to_dict()

        items = []
        for items_item_data in self.items:
            items_item = items_item_data.to_dict()
            items.append(items_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "mandateId": mandate_id,
                "manifest": manifest,
                "items": items,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.evidence_manifest import EvidenceManifest
        from ..models.evidence_upload_items_item import EvidenceUploadItemsItem

        d = dict(src_dict)
        mandate_id = d.pop("mandateId")

        manifest = EvidenceManifest.from_dict(d.pop("manifest"))

        items = []
        _items = d.pop("items")
        for items_item_data in _items:
            items_item = EvidenceUploadItemsItem.from_dict(items_item_data)

            items.append(items_item)

        evidence_upload = cls(
            mandate_id=mandate_id,
            manifest=manifest,
            items=items,
        )

        evidence_upload.additional_properties = d
        return evidence_upload

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
