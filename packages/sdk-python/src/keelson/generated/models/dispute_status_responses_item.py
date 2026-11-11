from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.dispute_status_responses_item_action import (
    DisputeStatusResponsesItemAction,
    check_dispute_status_responses_item_action,
)
from ..models.dispute_status_responses_item_drafted_by_type_1 import (
    DisputeStatusResponsesItemDraftedByType1,
    check_dispute_status_responses_item_drafted_by_type_1,
)
from ..models.dispute_status_responses_item_drafted_by_type_2_type_1 import (
    DisputeStatusResponsesItemDraftedByType2Type1,
    check_dispute_status_responses_item_drafted_by_type_2_type_1,
)
from ..models.dispute_status_responses_item_drafted_by_type_3_type_1 import (
    DisputeStatusResponsesItemDraftedByType3Type1,
    check_dispute_status_responses_item_drafted_by_type_3_type_1,
)

T = TypeVar("T", bound="DisputeStatusResponsesItem")


@_attrs_define
class DisputeStatusResponsesItem:
    """
    Attributes:
        action (DisputeStatusResponsesItemAction):
        stage (str): PayPal's lifecycle stage when it was sent.
        evidence_types (list[str]):
        drafted_by (DisputeStatusResponsesItemDraftedByType1 | DisputeStatusResponsesItemDraftedByType2Type1 |
            DisputeStatusResponsesItemDraftedByType3Type1 | None): `model` when the statement was drafted with citations;
            `template` when the rule's fixed statement was sent. Null for an accepted claim.
        citations (int): How many passages of the Alibi and the verdict the statement cites. The statement itself is not
            public: it quotes the purchase's Alibi.
        sent_at (datetime.datetime):
    """

    action: DisputeStatusResponsesItemAction
    stage: str
    evidence_types: list[str]
    drafted_by: (
        DisputeStatusResponsesItemDraftedByType1
        | DisputeStatusResponsesItemDraftedByType2Type1
        | DisputeStatusResponsesItemDraftedByType3Type1
        | None
    )
    citations: int
    sent_at: datetime.datetime
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        action: str = self.action

        stage = self.stage

        evidence_types = self.evidence_types

        drafted_by: str | None
        if (
            isinstance(self.drafted_by, str)
            or isinstance(self.drafted_by, str)
            or isinstance(self.drafted_by, str)
        ):
            drafted_by = self.drafted_by
        else:
            drafted_by = self.drafted_by

        citations = self.citations

        sent_at = self.sent_at.isoformat()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "action": action,
                "stage": stage,
                "evidence_types": evidence_types,
                "drafted_by": drafted_by,
                "citations": citations,
                "sent_at": sent_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        action = check_dispute_status_responses_item_action(d.pop("action"))

        stage = d.pop("stage")

        evidence_types = cast(list[str], d.pop("evidence_types"))

        def _parse_drafted_by(
            data: object,
        ) -> (
            DisputeStatusResponsesItemDraftedByType1
            | DisputeStatusResponsesItemDraftedByType2Type1
            | DisputeStatusResponsesItemDraftedByType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                drafted_by_type_1 = check_dispute_status_responses_item_drafted_by_type_1(data)

                return drafted_by_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                drafted_by_type_2_type_1 = (
                    check_dispute_status_responses_item_drafted_by_type_2_type_1(data)
                )

                return drafted_by_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                drafted_by_type_3_type_1 = (
                    check_dispute_status_responses_item_drafted_by_type_3_type_1(data)
                )

                return drafted_by_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                DisputeStatusResponsesItemDraftedByType1
                | DisputeStatusResponsesItemDraftedByType2Type1
                | DisputeStatusResponsesItemDraftedByType3Type1
                | None,
                data,
            )

        drafted_by = _parse_drafted_by(d.pop("drafted_by"))

        citations = d.pop("citations")

        sent_at = datetime.datetime.fromisoformat(d.pop("sent_at"))

        dispute_status_responses_item = cls(
            action=action,
            stage=stage,
            evidence_types=evidence_types,
            drafted_by=drafted_by,
            citations=citations,
            sent_at=sent_at,
        )

        dispute_status_responses_item.additional_properties = d
        return dispute_status_responses_item

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
