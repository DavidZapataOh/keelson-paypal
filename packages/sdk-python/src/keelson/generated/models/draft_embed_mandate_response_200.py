from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.draft_embed_mandate_response_200_check import DraftEmbedMandateResponse200Check
    from ..models.draft_embed_mandate_response_200_mandate_draft import (
        DraftEmbedMandateResponse200MandateDraft,
    )
    from ..models.mandate_card import MandateCard


T = TypeVar("T", bound="DraftEmbedMandateResponse200")


@_attrs_define
class DraftEmbedMandateResponse200:
    """
    Attributes:
        mandate_draft (DraftEmbedMandateResponse200MandateDraft):
        card (MandateCard):
        ambiguous (list[str]):
        check (DraftEmbedMandateResponse200Check):
    """

    mandate_draft: DraftEmbedMandateResponse200MandateDraft
    card: MandateCard
    ambiguous: list[str]
    check: DraftEmbedMandateResponse200Check
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        mandate_draft = self.mandate_draft.to_dict()

        card = self.card.to_dict()

        ambiguous = self.ambiguous

        check = self.check.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "mandateDraft": mandate_draft,
                "card": card,
                "ambiguous": ambiguous,
                "check": check,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.draft_embed_mandate_response_200_check import (
            DraftEmbedMandateResponse200Check,
        )
        from ..models.draft_embed_mandate_response_200_mandate_draft import (
            DraftEmbedMandateResponse200MandateDraft,
        )
        from ..models.mandate_card import MandateCard

        d = dict(src_dict)
        mandate_draft = DraftEmbedMandateResponse200MandateDraft.from_dict(d.pop("mandateDraft"))

        card = MandateCard.from_dict(d.pop("card"))

        ambiguous = cast(list[str], d.pop("ambiguous"))

        check = DraftEmbedMandateResponse200Check.from_dict(d.pop("check"))

        draft_embed_mandate_response_200 = cls(
            mandate_draft=mandate_draft,
            card=card,
            ambiguous=ambiguous,
            check=check,
        )

        draft_embed_mandate_response_200.additional_properties = d
        return draft_embed_mandate_response_200

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
