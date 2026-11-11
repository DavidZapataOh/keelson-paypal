from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.web_fact_web_fact_web_fact import WebFactWebFactWebFact


T = TypeVar("T", bound="WebFactWebFact")


@_attrs_define
class WebFactWebFact:
    """
    Attributes:
        web_fact (WebFactWebFactWebFact):
        chain_id (int):
        digest (str):
        signature (str):
        signer (str):
    """

    web_fact: WebFactWebFactWebFact
    chain_id: int
    digest: str
    signature: str
    signer: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        web_fact = self.web_fact.to_dict()

        chain_id = self.chain_id

        digest = self.digest

        signature = self.signature

        signer = self.signer

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "web_fact": web_fact,
                "chain_id": chain_id,
                "digest": digest,
                "signature": signature,
                "signer": signer,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.web_fact_web_fact_web_fact import WebFactWebFactWebFact

        d = dict(src_dict)
        web_fact = WebFactWebFactWebFact.from_dict(d.pop("web_fact"))

        chain_id = d.pop("chain_id")

        digest = d.pop("digest")

        signature = d.pop("signature")

        signer = d.pop("signer")

        web_fact_web_fact = cls(
            web_fact=web_fact,
            chain_id=chain_id,
            digest=digest,
            signature=signature,
            signer=signer,
        )

        web_fact_web_fact.additional_properties = d
        return web_fact_web_fact

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
