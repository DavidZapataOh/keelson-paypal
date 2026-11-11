from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

T = TypeVar("T", bound="MandateDraftIntent")


@_attrs_define
class MandateDraftIntent:
    """
    Attributes:
        prompt_summary (str):
        prompt_hash (str):
        subjective (list[str]):
    """

    prompt_summary: str
    prompt_hash: str
    subjective: list[str]

    def to_dict(self) -> dict[str, Any]:
        prompt_summary = self.prompt_summary

        prompt_hash = self.prompt_hash

        subjective = self.subjective

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "prompt_summary": prompt_summary,
                "prompt_hash": prompt_hash,
                "subjective": subjective,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        prompt_summary = d.pop("prompt_summary")

        prompt_hash = d.pop("prompt_hash")

        subjective = cast(list[str], d.pop("subjective"))

        mandate_draft_intent = cls(
            prompt_summary=prompt_summary,
            prompt_hash=prompt_hash,
            subjective=subjective,
        )

        return mandate_draft_intent
