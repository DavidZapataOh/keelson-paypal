from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.dispute_status_liable_type_1 import (
    DisputeStatusLiableType1,
    check_dispute_status_liable_type_1,
)
from ..models.dispute_status_liable_type_2_type_1 import (
    DisputeStatusLiableType2Type1,
    check_dispute_status_liable_type_2_type_1,
)
from ..models.dispute_status_liable_type_3_type_1 import (
    DisputeStatusLiableType3Type1,
    check_dispute_status_liable_type_3_type_1,
)
from ..models.dispute_status_state import DisputeStatusState, check_dispute_status_state

if TYPE_CHECKING:
    from ..models.amber_case import AmberCase
    from ..models.dispute_status_parties_item import DisputeStatusPartiesItem
    from ..models.dispute_status_responses_item import DisputeStatusResponsesItem
    from ..models.dispute_status_settlement import DisputeStatusSettlement
    from ..models.dispute_status_verdict import DisputeStatusVerdict


T = TypeVar("T", bound="DisputeStatus")


@_attrs_define
class DisputeStatus:
    """
    Attributes:
        dispute_id (str):
        purchase_id (str):
        state (DisputeStatusState):
        reason (str): PayPal's `dispute_reason`.
        received_at (datetime.datetime | None): When Keelson received the dispute's first webhook or poll.
        attributed_at (datetime.datetime | None):
        elapsed_ms (int | None): From `received_at` to `attributed_at`; null while the dispute is open.
        liable (DisputeStatusLiableType1 | DisputeStatusLiableType2Type1 | DisputeStatusLiableType3Type1 | None):
        parties (list[DisputeStatusPartiesItem]): The parties a verdict can make pay: the operator's bond, Keelson's
            reserve, or the merchant through PayPal.
        verdict (DisputeStatusVerdict | None):
        settlement (DisputeStatusSettlement | None):
        responses (list[DisputeStatusResponsesItem]): What Keelson sent PayPal for the party at fault. The action and
            the evidence types follow from the rule; a model only drafts the text.
        amber (AmberCase | None):
    """

    dispute_id: str
    purchase_id: str
    state: DisputeStatusState
    reason: str
    received_at: datetime.datetime | None
    attributed_at: datetime.datetime | None
    elapsed_ms: int | None
    liable: (
        DisputeStatusLiableType1
        | DisputeStatusLiableType2Type1
        | DisputeStatusLiableType3Type1
        | None
    )
    parties: list[DisputeStatusPartiesItem]
    verdict: DisputeStatusVerdict | None
    settlement: DisputeStatusSettlement | None
    responses: list[DisputeStatusResponsesItem]
    amber: AmberCase | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.amber_case import AmberCase
        from ..models.dispute_status_settlement import DisputeStatusSettlement
        from ..models.dispute_status_verdict import DisputeStatusVerdict

        dispute_id = self.dispute_id

        purchase_id = self.purchase_id

        state: str = self.state

        reason = self.reason

        received_at: str | None
        if isinstance(self.received_at, datetime.datetime):
            received_at = self.received_at.isoformat()
        else:
            received_at = self.received_at

        attributed_at: str | None
        if isinstance(self.attributed_at, datetime.datetime):
            attributed_at = self.attributed_at.isoformat()
        else:
            attributed_at = self.attributed_at

        elapsed_ms: int | None
        elapsed_ms = self.elapsed_ms

        liable: str | None
        if (
            isinstance(self.liable, str)
            or isinstance(self.liable, str)
            or isinstance(self.liable, str)
        ):
            liable = self.liable
        else:
            liable = self.liable

        parties = []
        for parties_item_data in self.parties:
            parties_item = parties_item_data.to_dict()
            parties.append(parties_item)

        verdict: dict[str, Any] | None
        if isinstance(self.verdict, DisputeStatusVerdict):
            verdict = self.verdict.to_dict()
        else:
            verdict = self.verdict

        settlement: dict[str, Any] | None
        if isinstance(self.settlement, DisputeStatusSettlement):
            settlement = self.settlement.to_dict()
        else:
            settlement = self.settlement

        responses = []
        for responses_item_data in self.responses:
            responses_item = responses_item_data.to_dict()
            responses.append(responses_item)

        amber: dict[str, Any] | None
        if isinstance(self.amber, AmberCase):
            amber = self.amber.to_dict()
        else:
            amber = self.amber

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "dispute_id": dispute_id,
                "purchase_id": purchase_id,
                "state": state,
                "reason": reason,
                "received_at": received_at,
                "attributed_at": attributed_at,
                "elapsed_ms": elapsed_ms,
                "liable": liable,
                "parties": parties,
                "verdict": verdict,
                "settlement": settlement,
                "responses": responses,
                "amber": amber,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.amber_case import AmberCase
        from ..models.dispute_status_parties_item import DisputeStatusPartiesItem
        from ..models.dispute_status_responses_item import DisputeStatusResponsesItem
        from ..models.dispute_status_settlement import DisputeStatusSettlement
        from ..models.dispute_status_verdict import DisputeStatusVerdict

        d = dict(src_dict)
        dispute_id = d.pop("dispute_id")

        purchase_id = d.pop("purchase_id")

        state = check_dispute_status_state(d.pop("state"))

        reason = d.pop("reason")

        def _parse_received_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                received_at_type_0 = datetime.datetime.fromisoformat(data)

                return received_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        received_at = _parse_received_at(d.pop("received_at"))

        def _parse_attributed_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                attributed_at_type_0 = datetime.datetime.fromisoformat(data)

                return attributed_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        attributed_at = _parse_attributed_at(d.pop("attributed_at"))

        def _parse_elapsed_ms(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        elapsed_ms = _parse_elapsed_ms(d.pop("elapsed_ms"))

        def _parse_liable(
            data: object,
        ) -> (
            DisputeStatusLiableType1
            | DisputeStatusLiableType2Type1
            | DisputeStatusLiableType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                liable_type_1 = check_dispute_status_liable_type_1(data)

                return liable_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                liable_type_2_type_1 = check_dispute_status_liable_type_2_type_1(data)

                return liable_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                liable_type_3_type_1 = check_dispute_status_liable_type_3_type_1(data)

                return liable_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                DisputeStatusLiableType1
                | DisputeStatusLiableType2Type1
                | DisputeStatusLiableType3Type1
                | None,
                data,
            )

        liable = _parse_liable(d.pop("liable"))

        parties = []
        _parties = d.pop("parties")
        for parties_item_data in _parties:
            parties_item = DisputeStatusPartiesItem.from_dict(parties_item_data)

            parties.append(parties_item)

        def _parse_verdict(data: object) -> DisputeStatusVerdict | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                verdict_type_0 = DisputeStatusVerdict.from_dict(data)

                return verdict_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(DisputeStatusVerdict | None, data)

        verdict = _parse_verdict(d.pop("verdict"))

        def _parse_settlement(data: object) -> DisputeStatusSettlement | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                settlement_type_0 = DisputeStatusSettlement.from_dict(data)

                return settlement_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(DisputeStatusSettlement | None, data)

        settlement = _parse_settlement(d.pop("settlement"))

        responses = []
        _responses = d.pop("responses")
        for responses_item_data in _responses:
            responses_item = DisputeStatusResponsesItem.from_dict(responses_item_data)

            responses.append(responses_item)

        def _parse_amber(data: object) -> AmberCase | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                amber_type_0 = AmberCase.from_dict(data)

                return amber_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(AmberCase | None, data)

        amber = _parse_amber(d.pop("amber"))

        dispute_status = cls(
            dispute_id=dispute_id,
            purchase_id=purchase_id,
            state=state,
            reason=reason,
            received_at=received_at,
            attributed_at=attributed_at,
            elapsed_ms=elapsed_ms,
            liable=liable,
            parties=parties,
            verdict=verdict,
            settlement=settlement,
            responses=responses,
            amber=amber,
        )

        dispute_status.additional_properties = d
        return dispute_status

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
