from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.merchant_dispute_liable_type_1 import (
    MerchantDisputeLiableType1,
    check_merchant_dispute_liable_type_1,
)
from ..models.merchant_dispute_liable_type_2_type_1 import (
    MerchantDisputeLiableType2Type1,
    check_merchant_dispute_liable_type_2_type_1,
)
from ..models.merchant_dispute_liable_type_3_type_1 import (
    MerchantDisputeLiableType3Type1,
    check_merchant_dispute_liable_type_3_type_1,
)
from ..models.merchant_dispute_outcome_type_1 import (
    MerchantDisputeOutcomeType1,
    check_merchant_dispute_outcome_type_1,
)
from ..models.merchant_dispute_outcome_type_2_type_1 import (
    MerchantDisputeOutcomeType2Type1,
    check_merchant_dispute_outcome_type_2_type_1,
)
from ..models.merchant_dispute_outcome_type_3_type_1 import (
    MerchantDisputeOutcomeType3Type1,
    check_merchant_dispute_outcome_type_3_type_1,
)
from ..models.merchant_dispute_paid_by_type_1 import (
    MerchantDisputePaidByType1,
    check_merchant_dispute_paid_by_type_1,
)
from ..models.merchant_dispute_paid_by_type_2_type_1 import (
    MerchantDisputePaidByType2Type1,
    check_merchant_dispute_paid_by_type_2_type_1,
)
from ..models.merchant_dispute_paid_by_type_3_type_1 import (
    MerchantDisputePaidByType3Type1,
    check_merchant_dispute_paid_by_type_3_type_1,
)
from ..models.merchant_dispute_rail_type_1 import (
    MerchantDisputeRailType1,
    check_merchant_dispute_rail_type_1,
)
from ..models.merchant_dispute_rail_type_2_type_1 import (
    MerchantDisputeRailType2Type1,
    check_merchant_dispute_rail_type_2_type_1,
)
from ..models.merchant_dispute_rail_type_3_type_1 import (
    MerchantDisputeRailType3Type1,
    check_merchant_dispute_rail_type_3_type_1,
)
from ..models.merchant_dispute_state import MerchantDisputeState, check_merchant_dispute_state

if TYPE_CHECKING:
    from ..models.amber_case import AmberCase


T = TypeVar("T", bound="MerchantDispute")


@_attrs_define
class MerchantDispute:
    """
    Attributes:
        dispute_id (str):
        purchase_id (str): Also the id of the purchase's Alibi.
        state (MerchantDisputeState):
        reason (str):
        amount_minor (str):
        currency (str):
        agent_id (str): The ERC-8004 agent that made the purchase.
        received_at (datetime.datetime | None):
        attributed_at (datetime.datetime | None):
        elapsed_ms (int | None):
        liable (MerchantDisputeLiableType1 | MerchantDisputeLiableType2Type1 | MerchantDisputeLiableType3Type1 | None):
        rule (None | str):
        rail (MerchantDisputeRailType1 | MerchantDisputeRailType2Type1 | MerchantDisputeRailType3Type1 | None):
        outcome (MerchantDisputeOutcomeType1 | MerchantDisputeOutcomeType2Type1 | MerchantDisputeOutcomeType3Type1 |
            None):
        paid_by (MerchantDisputePaidByType1 | MerchantDisputePaidByType2Type1 | MerchantDisputePaidByType3Type1 | None):
        ready_at (datetime.datetime | None):
        settled_at (datetime.datetime | None):
        explorer_url (None | str):
        has_alibi (bool):
        amber (AmberCase | None):
    """

    dispute_id: str
    purchase_id: str
    state: MerchantDisputeState
    reason: str
    amount_minor: str
    currency: str
    agent_id: str
    received_at: datetime.datetime | None
    attributed_at: datetime.datetime | None
    elapsed_ms: int | None
    liable: (
        MerchantDisputeLiableType1
        | MerchantDisputeLiableType2Type1
        | MerchantDisputeLiableType3Type1
        | None
    )
    rule: str | None
    rail: (
        MerchantDisputeRailType1
        | MerchantDisputeRailType2Type1
        | MerchantDisputeRailType3Type1
        | None
    )
    outcome: (
        MerchantDisputeOutcomeType1
        | MerchantDisputeOutcomeType2Type1
        | MerchantDisputeOutcomeType3Type1
        | None
    )
    paid_by: (
        MerchantDisputePaidByType1
        | MerchantDisputePaidByType2Type1
        | MerchantDisputePaidByType3Type1
        | None
    )
    ready_at: datetime.datetime | None
    settled_at: datetime.datetime | None
    explorer_url: str | None
    has_alibi: bool
    amber: AmberCase | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.amber_case import AmberCase

        dispute_id = self.dispute_id

        purchase_id = self.purchase_id

        state: str = self.state

        reason = self.reason

        amount_minor = self.amount_minor

        currency = self.currency

        agent_id = self.agent_id

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

        rule: str | None
        rule = self.rule

        rail: str | None
        if isinstance(self.rail, str) or isinstance(self.rail, str) or isinstance(self.rail, str):
            rail = self.rail
        else:
            rail = self.rail

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

        ready_at: str | None
        if isinstance(self.ready_at, datetime.datetime):
            ready_at = self.ready_at.isoformat()
        else:
            ready_at = self.ready_at

        settled_at: str | None
        if isinstance(self.settled_at, datetime.datetime):
            settled_at = self.settled_at.isoformat()
        else:
            settled_at = self.settled_at

        explorer_url: str | None
        explorer_url = self.explorer_url

        has_alibi = self.has_alibi

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
                "amount_minor": amount_minor,
                "currency": currency,
                "agent_id": agent_id,
                "received_at": received_at,
                "attributed_at": attributed_at,
                "elapsed_ms": elapsed_ms,
                "liable": liable,
                "rule": rule,
                "rail": rail,
                "outcome": outcome,
                "paid_by": paid_by,
                "ready_at": ready_at,
                "settled_at": settled_at,
                "explorer_url": explorer_url,
                "has_alibi": has_alibi,
                "amber": amber,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.amber_case import AmberCase

        d = dict(src_dict)
        dispute_id = d.pop("dispute_id")

        purchase_id = d.pop("purchase_id")

        state = check_merchant_dispute_state(d.pop("state"))

        reason = d.pop("reason")

        amount_minor = d.pop("amount_minor")

        currency = d.pop("currency")

        agent_id = d.pop("agent_id")

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
            MerchantDisputeLiableType1
            | MerchantDisputeLiableType2Type1
            | MerchantDisputeLiableType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                liable_type_1 = check_merchant_dispute_liable_type_1(data)

                return liable_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                liable_type_2_type_1 = check_merchant_dispute_liable_type_2_type_1(data)

                return liable_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                liable_type_3_type_1 = check_merchant_dispute_liable_type_3_type_1(data)

                return liable_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                MerchantDisputeLiableType1
                | MerchantDisputeLiableType2Type1
                | MerchantDisputeLiableType3Type1
                | None,
                data,
            )

        liable = _parse_liable(d.pop("liable"))

        def _parse_rule(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        rule = _parse_rule(d.pop("rule"))

        def _parse_rail(
            data: object,
        ) -> (
            MerchantDisputeRailType1
            | MerchantDisputeRailType2Type1
            | MerchantDisputeRailType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                rail_type_1 = check_merchant_dispute_rail_type_1(data)

                return rail_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                rail_type_2_type_1 = check_merchant_dispute_rail_type_2_type_1(data)

                return rail_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                rail_type_3_type_1 = check_merchant_dispute_rail_type_3_type_1(data)

                return rail_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                MerchantDisputeRailType1
                | MerchantDisputeRailType2Type1
                | MerchantDisputeRailType3Type1
                | None,
                data,
            )

        rail = _parse_rail(d.pop("rail"))

        def _parse_outcome(
            data: object,
        ) -> (
            MerchantDisputeOutcomeType1
            | MerchantDisputeOutcomeType2Type1
            | MerchantDisputeOutcomeType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                outcome_type_1 = check_merchant_dispute_outcome_type_1(data)

                return outcome_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                outcome_type_2_type_1 = check_merchant_dispute_outcome_type_2_type_1(data)

                return outcome_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                outcome_type_3_type_1 = check_merchant_dispute_outcome_type_3_type_1(data)

                return outcome_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                MerchantDisputeOutcomeType1
                | MerchantDisputeOutcomeType2Type1
                | MerchantDisputeOutcomeType3Type1
                | None,
                data,
            )

        outcome = _parse_outcome(d.pop("outcome"))

        def _parse_paid_by(
            data: object,
        ) -> (
            MerchantDisputePaidByType1
            | MerchantDisputePaidByType2Type1
            | MerchantDisputePaidByType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                paid_by_type_1 = check_merchant_dispute_paid_by_type_1(data)

                return paid_by_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                paid_by_type_2_type_1 = check_merchant_dispute_paid_by_type_2_type_1(data)

                return paid_by_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                paid_by_type_3_type_1 = check_merchant_dispute_paid_by_type_3_type_1(data)

                return paid_by_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                MerchantDisputePaidByType1
                | MerchantDisputePaidByType2Type1
                | MerchantDisputePaidByType3Type1
                | None,
                data,
            )

        paid_by = _parse_paid_by(d.pop("paid_by"))

        def _parse_ready_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                ready_at_type_0 = datetime.datetime.fromisoformat(data)

                return ready_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        ready_at = _parse_ready_at(d.pop("ready_at"))

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

        settled_at = _parse_settled_at(d.pop("settled_at"))

        def _parse_explorer_url(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        explorer_url = _parse_explorer_url(d.pop("explorer_url"))

        has_alibi = d.pop("has_alibi")

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

        merchant_dispute = cls(
            dispute_id=dispute_id,
            purchase_id=purchase_id,
            state=state,
            reason=reason,
            amount_minor=amount_minor,
            currency=currency,
            agent_id=agent_id,
            received_at=received_at,
            attributed_at=attributed_at,
            elapsed_ms=elapsed_ms,
            liable=liable,
            rule=rule,
            rail=rail,
            outcome=outcome,
            paid_by=paid_by,
            ready_at=ready_at,
            settled_at=settled_at,
            explorer_url=explorer_url,
            has_alibi=has_alibi,
            amber=amber,
        )

        merchant_dispute.additional_properties = d
        return merchant_dispute

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
