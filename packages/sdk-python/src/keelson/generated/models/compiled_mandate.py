from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.compiled_mandate_ambiguous_item import (
    CompiledMandateAmbiguousItem,
    check_compiled_mandate_ambiguous_item,
)

if TYPE_CHECKING:
    from ..models.compiled_mandate_check import CompiledMandateCheck
    from ..models.mandate_card import MandateCard
    from ..models.mandate_draft import MandateDraft


T = TypeVar("T", bound="CompiledMandate")


@_attrs_define
class CompiledMandate:
    """
    Attributes:
        mandate_draft (MandateDraft): The compiled `keelson.mandate.1` payload, unsigned; its commitment is zero.
        card (MandateCard):
        ambiguous (list[CompiledMandateAmbiguousItem]): Card fields the compilations disagreed on or the request left
            unstated, shown gray for the user to settle. Pass them to `prepareSigning` so the card the user signs shows them
            gray too.
        check (CompiledMandateCheck): The round trip of the card against the request. Only `ok` means it was checked.
    """

    mandate_draft: MandateDraft
    card: MandateCard
    ambiguous: list[CompiledMandateAmbiguousItem]
    check: CompiledMandateCheck
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        mandate_draft = self.mandate_draft.to_dict()

        card = self.card.to_dict()

        ambiguous = []
        for ambiguous_item_data in self.ambiguous:
            ambiguous_item: str = ambiguous_item_data
            ambiguous.append(ambiguous_item)

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
        from ..models.compiled_mandate_check import CompiledMandateCheck
        from ..models.mandate_card import MandateCard
        from ..models.mandate_draft import MandateDraft

        d = dict(src_dict)
        mandate_draft = MandateDraft.from_dict(d.pop("mandateDraft"))

        card = MandateCard.from_dict(d.pop("card"))

        ambiguous = []
        _ambiguous = d.pop("ambiguous")
        for ambiguous_item_data in _ambiguous:
            ambiguous_item = check_compiled_mandate_ambiguous_item(ambiguous_item_data)

            ambiguous.append(ambiguous_item)

        check = CompiledMandateCheck.from_dict(d.pop("check"))

        compiled_mandate = cls(
            mandate_draft=mandate_draft,
            card=card,
            ambiguous=ambiguous,
            check=check,
        )

        compiled_mandate.additional_properties = d
        return compiled_mandate

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
