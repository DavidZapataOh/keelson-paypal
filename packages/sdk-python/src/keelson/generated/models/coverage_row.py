from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.coverage_row_amber import CoverageRowAmber, check_coverage_row_amber
from ..models.coverage_row_amber_field_type_1 import (
    CoverageRowAmberFieldType1,
    check_coverage_row_amber_field_type_1,
)
from ..models.coverage_row_amber_field_type_2_type_1 import (
    CoverageRowAmberFieldType2Type1,
    check_coverage_row_amber_field_type_2_type_1,
)
from ..models.coverage_row_amber_field_type_3_type_1 import (
    CoverageRowAmberFieldType3Type1,
    check_coverage_row_amber_field_type_3_type_1,
)
from ..models.coverage_row_dispute_state_type_1 import (
    CoverageRowDisputeStateType1,
    check_coverage_row_dispute_state_type_1,
)
from ..models.coverage_row_dispute_state_type_2_type_1 import (
    CoverageRowDisputeStateType2Type1,
    check_coverage_row_dispute_state_type_2_type_1,
)
from ..models.coverage_row_dispute_state_type_3_type_1 import (
    CoverageRowDisputeStateType3Type1,
    check_coverage_row_dispute_state_type_3_type_1,
)
from ..models.coverage_row_liable_type_1 import (
    CoverageRowLiableType1,
    check_coverage_row_liable_type_1,
)
from ..models.coverage_row_liable_type_2_type_1 import (
    CoverageRowLiableType2Type1,
    check_coverage_row_liable_type_2_type_1,
)
from ..models.coverage_row_liable_type_3_type_1 import (
    CoverageRowLiableType3Type1,
    check_coverage_row_liable_type_3_type_1,
)
from ..models.coverage_row_outcome_type_1 import (
    CoverageRowOutcomeType1,
    check_coverage_row_outcome_type_1,
)
from ..models.coverage_row_outcome_type_2_type_1 import (
    CoverageRowOutcomeType2Type1,
    check_coverage_row_outcome_type_2_type_1,
)
from ..models.coverage_row_outcome_type_3_type_1 import (
    CoverageRowOutcomeType3Type1,
    check_coverage_row_outcome_type_3_type_1,
)
from ..models.coverage_row_paid_by_type_1 import (
    CoverageRowPaidByType1,
    check_coverage_row_paid_by_type_1,
)
from ..models.coverage_row_paid_by_type_2_type_1 import (
    CoverageRowPaidByType2Type1,
    check_coverage_row_paid_by_type_2_type_1,
)
from ..models.coverage_row_paid_by_type_3_type_1 import (
    CoverageRowPaidByType3Type1,
    check_coverage_row_paid_by_type_3_type_1,
)

T = TypeVar("T", bound="CoverageRow")


@_attrs_define
class CoverageRow:
    """
    Attributes:
        id (str): The purchase id, also its Alibi's.
        created_at (datetime.datetime):
        merchant_id (str):
        amount (float): US dollars.
        premium_bps (int | None):
        premium (float): US dollars.
        state (str):
        coverage_tx (None | str):
        dispute_id (None | str):
        dispute_state (CoverageRowDisputeStateType1 | CoverageRowDisputeStateType2Type1 |
            CoverageRowDisputeStateType3Type1 | None):
        dispute_reason (None | str):
        disputed_at (datetime.datetime | None):
        liable (CoverageRowLiableType1 | CoverageRowLiableType2Type1 | CoverageRowLiableType3Type1 | None):
        rule (None | str):
        verdict_amount (float | None): US dollars.
        verdict_at (datetime.datetime | None):
        outcome (CoverageRowOutcomeType1 | CoverageRowOutcomeType2Type1 | CoverageRowOutcomeType3Type1 | None):
        paid_by (CoverageRowPaidByType1 | CoverageRowPaidByType2Type1 | CoverageRowPaidByType3Type1 | None):
        settlement_tx (None | str):
        settled_at (datetime.datetime | None):
        amber (CoverageRowAmber): `attested`: you signed an amber commitment of the item into the coverage.
            `contradicted`: `AmberContradictionCourt` convicted it with a C2b proof.
        amber_commitment (None | str):
        amber_field (CoverageRowAmberFieldType1 | CoverageRowAmberFieldType2Type1 | CoverageRowAmberFieldType3Type1 |
            None): The field the court found false.
        amber_claimed (None | str): What you attested of that field.
        amber_proven_at (datetime.datetime | None):
        amber_web_fact (None | str): The digest of the `WebFact` the proof opened.
        amber_tx (None | str):
    """

    id: str
    created_at: datetime.datetime
    merchant_id: str
    amount: float
    premium_bps: int | None
    premium: float
    state: str
    coverage_tx: str | None
    dispute_id: str | None
    dispute_state: (
        CoverageRowDisputeStateType1
        | CoverageRowDisputeStateType2Type1
        | CoverageRowDisputeStateType3Type1
        | None
    )
    dispute_reason: str | None
    disputed_at: datetime.datetime | None
    liable: (
        CoverageRowLiableType1 | CoverageRowLiableType2Type1 | CoverageRowLiableType3Type1 | None
    )
    rule: str | None
    verdict_amount: float | None
    verdict_at: datetime.datetime | None
    outcome: (
        CoverageRowOutcomeType1 | CoverageRowOutcomeType2Type1 | CoverageRowOutcomeType3Type1 | None
    )
    paid_by: (
        CoverageRowPaidByType1 | CoverageRowPaidByType2Type1 | CoverageRowPaidByType3Type1 | None
    )
    settlement_tx: str | None
    settled_at: datetime.datetime | None
    amber: CoverageRowAmber
    amber_commitment: str | None
    amber_field: (
        CoverageRowAmberFieldType1
        | CoverageRowAmberFieldType2Type1
        | CoverageRowAmberFieldType3Type1
        | None
    )
    amber_claimed: str | None
    amber_proven_at: datetime.datetime | None
    amber_web_fact: str | None
    amber_tx: str | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        created_at = self.created_at.isoformat()

        merchant_id = self.merchant_id

        amount = self.amount

        premium_bps: int | None
        premium_bps = self.premium_bps

        premium = self.premium

        state = self.state

        coverage_tx: str | None
        coverage_tx = self.coverage_tx

        dispute_id: str | None
        dispute_id = self.dispute_id

        dispute_state: str | None
        if (
            isinstance(self.dispute_state, str)
            or isinstance(self.dispute_state, str)
            or isinstance(self.dispute_state, str)
        ):
            dispute_state = self.dispute_state
        else:
            dispute_state = self.dispute_state

        dispute_reason: str | None
        dispute_reason = self.dispute_reason

        disputed_at: str | None
        if isinstance(self.disputed_at, datetime.datetime):
            disputed_at = self.disputed_at.isoformat()
        else:
            disputed_at = self.disputed_at

        liable: str | None
        if (
            isinstance(self.liable, str)
            or isinstance(self.liable, str)
            or isinstance(self.liable, str)
        ):
            liable = self.liable
        else:
            liable = self.liable

        rule: str | None
        rule = self.rule

        verdict_amount: float | None
        verdict_amount = self.verdict_amount

        verdict_at: str | None
        if isinstance(self.verdict_at, datetime.datetime):
            verdict_at = self.verdict_at.isoformat()
        else:
            verdict_at = self.verdict_at

        outcome: str | None
        if (
            isinstance(self.outcome, str)
            or isinstance(self.outcome, str)
            or isinstance(self.outcome, str)
        ):
            outcome = self.outcome
        else:
            outcome = self.outcome

        paid_by: str | None
        if (
            isinstance(self.paid_by, str)
            or isinstance(self.paid_by, str)
            or isinstance(self.paid_by, str)
        ):
            paid_by = self.paid_by
        else:
            paid_by = self.paid_by

        settlement_tx: str | None
        settlement_tx = self.settlement_tx

        settled_at: str | None
        if isinstance(self.settled_at, datetime.datetime):
            settled_at = self.settled_at.isoformat()
        else:
            settled_at = self.settled_at

        amber: str = self.amber

        amber_commitment: str | None
        amber_commitment = self.amber_commitment

        amber_field: str | None
        if (
            isinstance(self.amber_field, str)
            or isinstance(self.amber_field, str)
            or isinstance(self.amber_field, str)
        ):
            amber_field = self.amber_field
        else:
            amber_field = self.amber_field

        amber_claimed: str | None
        amber_claimed = self.amber_claimed

        amber_proven_at: str | None
        if isinstance(self.amber_proven_at, datetime.datetime):
            amber_proven_at = self.amber_proven_at.isoformat()
        else:
            amber_proven_at = self.amber_proven_at

        amber_web_fact: str | None
        amber_web_fact = self.amber_web_fact

        amber_tx: str | None
        amber_tx = self.amber_tx

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "createdAt": created_at,
                "merchantId": merchant_id,
                "amount": amount,
                "premiumBps": premium_bps,
                "premium": premium,
                "state": state,
                "coverageTx": coverage_tx,
                "disputeId": dispute_id,
                "disputeState": dispute_state,
                "disputeReason": dispute_reason,
                "disputedAt": disputed_at,
                "liable": liable,
                "rule": rule,
                "verdictAmount": verdict_amount,
                "verdictAt": verdict_at,
                "outcome": outcome,
                "paidBy": paid_by,
                "settlementTx": settlement_tx,
                "settledAt": settled_at,
                "amber": amber,
                "amberCommitment": amber_commitment,
                "amberField": amber_field,
                "amberClaimed": amber_claimed,
                "amberProvenAt": amber_proven_at,
                "amberWebFact": amber_web_fact,
                "amberTx": amber_tx,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        merchant_id = d.pop("merchantId")

        amount = d.pop("amount")

        def _parse_premium_bps(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        premium_bps = _parse_premium_bps(d.pop("premiumBps"))

        premium = d.pop("premium")

        state = d.pop("state")

        def _parse_coverage_tx(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        coverage_tx = _parse_coverage_tx(d.pop("coverageTx"))

        def _parse_dispute_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        dispute_id = _parse_dispute_id(d.pop("disputeId"))

        def _parse_dispute_state(
            data: object,
        ) -> (
            CoverageRowDisputeStateType1
            | CoverageRowDisputeStateType2Type1
            | CoverageRowDisputeStateType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                dispute_state_type_1 = check_coverage_row_dispute_state_type_1(data)

                return dispute_state_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                dispute_state_type_2_type_1 = check_coverage_row_dispute_state_type_2_type_1(data)

                return dispute_state_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                dispute_state_type_3_type_1 = check_coverage_row_dispute_state_type_3_type_1(data)

                return dispute_state_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                CoverageRowDisputeStateType1
                | CoverageRowDisputeStateType2Type1
                | CoverageRowDisputeStateType3Type1
                | None,
                data,
            )

        dispute_state = _parse_dispute_state(d.pop("disputeState"))

        def _parse_dispute_reason(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        dispute_reason = _parse_dispute_reason(d.pop("disputeReason"))

        def _parse_disputed_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                disputed_at_type_0 = datetime.datetime.fromisoformat(data)

                return disputed_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        disputed_at = _parse_disputed_at(d.pop("disputedAt"))

        def _parse_liable(
            data: object,
        ) -> (
            CoverageRowLiableType1
            | CoverageRowLiableType2Type1
            | CoverageRowLiableType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                liable_type_1 = check_coverage_row_liable_type_1(data)

                return liable_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                liable_type_2_type_1 = check_coverage_row_liable_type_2_type_1(data)

                return liable_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                liable_type_3_type_1 = check_coverage_row_liable_type_3_type_1(data)

                return liable_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                CoverageRowLiableType1
                | CoverageRowLiableType2Type1
                | CoverageRowLiableType3Type1
                | None,
                data,
            )

        liable = _parse_liable(d.pop("liable"))

        def _parse_rule(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        rule = _parse_rule(d.pop("rule"))

        def _parse_verdict_amount(data: object) -> float | None:
            if data is None:
                return data
            return cast(float | None, data)

        verdict_amount = _parse_verdict_amount(d.pop("verdictAmount"))

        def _parse_verdict_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                verdict_at_type_0 = datetime.datetime.fromisoformat(data)

                return verdict_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        verdict_at = _parse_verdict_at(d.pop("verdictAt"))

        def _parse_outcome(
            data: object,
        ) -> (
            CoverageRowOutcomeType1
            | CoverageRowOutcomeType2Type1
            | CoverageRowOutcomeType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                outcome_type_1 = check_coverage_row_outcome_type_1(data)

                return outcome_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                outcome_type_2_type_1 = check_coverage_row_outcome_type_2_type_1(data)

                return outcome_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                outcome_type_3_type_1 = check_coverage_row_outcome_type_3_type_1(data)

                return outcome_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                CoverageRowOutcomeType1
                | CoverageRowOutcomeType2Type1
                | CoverageRowOutcomeType3Type1
                | None,
                data,
            )

        outcome = _parse_outcome(d.pop("outcome"))

        def _parse_paid_by(
            data: object,
        ) -> (
            CoverageRowPaidByType1
            | CoverageRowPaidByType2Type1
            | CoverageRowPaidByType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                paid_by_type_1 = check_coverage_row_paid_by_type_1(data)

                return paid_by_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                paid_by_type_2_type_1 = check_coverage_row_paid_by_type_2_type_1(data)

                return paid_by_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                paid_by_type_3_type_1 = check_coverage_row_paid_by_type_3_type_1(data)

                return paid_by_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                CoverageRowPaidByType1
                | CoverageRowPaidByType2Type1
                | CoverageRowPaidByType3Type1
                | None,
                data,
            )

        paid_by = _parse_paid_by(d.pop("paidBy"))

        def _parse_settlement_tx(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        settlement_tx = _parse_settlement_tx(d.pop("settlementTx"))

        def _parse_settled_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                settled_at_type_0 = datetime.datetime.fromisoformat(data)

                return settled_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        settled_at = _parse_settled_at(d.pop("settledAt"))

        amber = check_coverage_row_amber(d.pop("amber"))

        def _parse_amber_commitment(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        amber_commitment = _parse_amber_commitment(d.pop("amberCommitment"))

        def _parse_amber_field(
            data: object,
        ) -> (
            CoverageRowAmberFieldType1
            | CoverageRowAmberFieldType2Type1
            | CoverageRowAmberFieldType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                amber_field_type_1 = check_coverage_row_amber_field_type_1(data)

                return amber_field_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                amber_field_type_2_type_1 = check_coverage_row_amber_field_type_2_type_1(data)

                return amber_field_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                amber_field_type_3_type_1 = check_coverage_row_amber_field_type_3_type_1(data)

                return amber_field_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                CoverageRowAmberFieldType1
                | CoverageRowAmberFieldType2Type1
                | CoverageRowAmberFieldType3Type1
                | None,
                data,
            )

        amber_field = _parse_amber_field(d.pop("amberField"))

        def _parse_amber_claimed(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        amber_claimed = _parse_amber_claimed(d.pop("amberClaimed"))

        def _parse_amber_proven_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                amber_proven_at_type_0 = datetime.datetime.fromisoformat(data)

                return amber_proven_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        amber_proven_at = _parse_amber_proven_at(d.pop("amberProvenAt"))

        def _parse_amber_web_fact(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        amber_web_fact = _parse_amber_web_fact(d.pop("amberWebFact"))

        def _parse_amber_tx(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        amber_tx = _parse_amber_tx(d.pop("amberTx"))

        coverage_row = cls(
            id=id,
            created_at=created_at,
            merchant_id=merchant_id,
            amount=amount,
            premium_bps=premium_bps,
            premium=premium,
            state=state,
            coverage_tx=coverage_tx,
            dispute_id=dispute_id,
            dispute_state=dispute_state,
            dispute_reason=dispute_reason,
            disputed_at=disputed_at,
            liable=liable,
            rule=rule,
            verdict_amount=verdict_amount,
            verdict_at=verdict_at,
            outcome=outcome,
            paid_by=paid_by,
            settlement_tx=settlement_tx,
            settled_at=settled_at,
            amber=amber,
            amber_commitment=amber_commitment,
            amber_field=amber_field,
            amber_claimed=amber_claimed,
            amber_proven_at=amber_proven_at,
            amber_web_fact=amber_web_fact,
            amber_tx=amber_tx,
        )

        coverage_row.additional_properties = d
        return coverage_row

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
