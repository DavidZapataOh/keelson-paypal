from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.dispute_status_settlement_outcome_type_1 import (
    DisputeStatusSettlementOutcomeType1,
    check_dispute_status_settlement_outcome_type_1,
)
from ..models.dispute_status_settlement_outcome_type_2_type_1 import (
    DisputeStatusSettlementOutcomeType2Type1,
    check_dispute_status_settlement_outcome_type_2_type_1,
)
from ..models.dispute_status_settlement_outcome_type_3_type_1 import (
    DisputeStatusSettlementOutcomeType3Type1,
    check_dispute_status_settlement_outcome_type_3_type_1,
)
from ..models.dispute_status_settlement_paid_by_type_1 import (
    DisputeStatusSettlementPaidByType1,
    check_dispute_status_settlement_paid_by_type_1,
)
from ..models.dispute_status_settlement_paid_by_type_2_type_1 import (
    DisputeStatusSettlementPaidByType2Type1,
    check_dispute_status_settlement_paid_by_type_2_type_1,
)
from ..models.dispute_status_settlement_paid_by_type_3_type_1 import (
    DisputeStatusSettlementPaidByType3Type1,
    check_dispute_status_settlement_paid_by_type_3_type_1,
)
from ..models.dispute_status_settlement_rail import (
    DisputeStatusSettlementRail,
    check_dispute_status_settlement_rail,
)

T = TypeVar("T", bound="DisputeStatusSettlement")


@_attrs_define
class DisputeStatusSettlement:
    """
    Attributes:
        rail (DisputeStatusSettlementRail): `pyusd`: the payee the verdict names is the merchant. `paypal`: it is
            Keelson's treasury, which pays the merchant a PayPal Payout.
        outcome (DisputeStatusSettlementOutcomeType1 | DisputeStatusSettlementOutcomeType2Type1 |
            DisputeStatusSettlementOutcomeType3Type1 | None): `queued`: the slash waits out the veto window until
            `ready_at`. `claimable`: the PYUSD transfer failed and waits as a claim. Null until the chain answered; always
            null when neither the operator nor Keelson is liable.
        failure (None | str): The contract error that refused the settlement on chain: of a `failed` one, or of one
            Keelson's treasury paid instead.
        paid_by (DisputeStatusSettlementPaidByType1 | DisputeStatusSettlementPaidByType2Type1 |
            DisputeStatusSettlementPaidByType3Type1 | None): `chain`: the operator's bond or Keelson's reserve paid.
            `violation-pool`: the operator's `ViolationBondPool` deposit paid the merchant on a court's conviction, with no
            verdict. `treasury`: the chain refused a verdict that still holds (its window or deadline had passed), so
            Keelson's treasury pays the payee itself, PYUSD on chain or a PayPal Payout; the settlement is paid once
            `outcome` is `paid`.
        refund_id (None | str): The buyer's PayPal refund; its `custom_id` is the verdict's `ksv1.` reference.
        tx_hash (None | str):
        explorer_url (None | str):
        ready_at (datetime.datetime | None):
        payout_batch_id (None | str):
        payout_status (None | str):
        settled_at (datetime.datetime | None):
    """

    rail: DisputeStatusSettlementRail
    outcome: (
        DisputeStatusSettlementOutcomeType1
        | DisputeStatusSettlementOutcomeType2Type1
        | DisputeStatusSettlementOutcomeType3Type1
        | None
    )
    failure: str | None
    paid_by: (
        DisputeStatusSettlementPaidByType1
        | DisputeStatusSettlementPaidByType2Type1
        | DisputeStatusSettlementPaidByType3Type1
        | None
    )
    refund_id: str | None
    tx_hash: str | None
    explorer_url: str | None
    ready_at: datetime.datetime | None
    payout_batch_id: str | None
    payout_status: str | None
    settled_at: datetime.datetime | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        rail: str = self.rail

        outcome: str | None
        if (
            isinstance(self.outcome, str)
            or isinstance(self.outcome, str)
            or isinstance(self.outcome, str)
        ):
            outcome = self.outcome
        else:
            outcome = self.outcome

        failure: str | None
        failure = self.failure

        paid_by: str | None
        if (
            isinstance(self.paid_by, str)
            or isinstance(self.paid_by, str)
            or isinstance(self.paid_by, str)
        ):
            paid_by = self.paid_by
        else:
            paid_by = self.paid_by

        refund_id: str | None
        refund_id = self.refund_id

        tx_hash: str | None
        tx_hash = self.tx_hash

        explorer_url: str | None
        explorer_url = self.explorer_url

        ready_at: str | None
        if isinstance(self.ready_at, datetime.datetime):
            ready_at = self.ready_at.isoformat()
        else:
            ready_at = self.ready_at

        payout_batch_id: str | None
        payout_batch_id = self.payout_batch_id

        payout_status: str | None
        payout_status = self.payout_status

        settled_at: str | None
        if isinstance(self.settled_at, datetime.datetime):
            settled_at = self.settled_at.isoformat()
        else:
            settled_at = self.settled_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "rail": rail,
                "outcome": outcome,
                "failure": failure,
                "paid_by": paid_by,
                "refund_id": refund_id,
                "tx_hash": tx_hash,
                "explorer_url": explorer_url,
                "ready_at": ready_at,
                "payout_batch_id": payout_batch_id,
                "payout_status": payout_status,
                "settled_at": settled_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        rail = check_dispute_status_settlement_rail(d.pop("rail"))

        def _parse_outcome(
            data: object,
        ) -> (
            DisputeStatusSettlementOutcomeType1
            | DisputeStatusSettlementOutcomeType2Type1
            | DisputeStatusSettlementOutcomeType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                outcome_type_1 = check_dispute_status_settlement_outcome_type_1(data)

                return outcome_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                outcome_type_2_type_1 = check_dispute_status_settlement_outcome_type_2_type_1(data)

                return outcome_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                outcome_type_3_type_1 = check_dispute_status_settlement_outcome_type_3_type_1(data)

                return outcome_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                DisputeStatusSettlementOutcomeType1
                | DisputeStatusSettlementOutcomeType2Type1
                | DisputeStatusSettlementOutcomeType3Type1
                | None,
                data,
            )

        outcome = _parse_outcome(d.pop("outcome"))

        def _parse_failure(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        failure = _parse_failure(d.pop("failure"))

        def _parse_paid_by(
            data: object,
        ) -> (
            DisputeStatusSettlementPaidByType1
            | DisputeStatusSettlementPaidByType2Type1
            | DisputeStatusSettlementPaidByType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                paid_by_type_1 = check_dispute_status_settlement_paid_by_type_1(data)

                return paid_by_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                paid_by_type_2_type_1 = check_dispute_status_settlement_paid_by_type_2_type_1(data)

                return paid_by_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                paid_by_type_3_type_1 = check_dispute_status_settlement_paid_by_type_3_type_1(data)

                return paid_by_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                DisputeStatusSettlementPaidByType1
                | DisputeStatusSettlementPaidByType2Type1
                | DisputeStatusSettlementPaidByType3Type1
                | None,
                data,
            )

        paid_by = _parse_paid_by(d.pop("paid_by"))

        def _parse_refund_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        refund_id = _parse_refund_id(d.pop("refund_id"))

        def _parse_tx_hash(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        tx_hash = _parse_tx_hash(d.pop("tx_hash"))

        def _parse_explorer_url(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        explorer_url = _parse_explorer_url(d.pop("explorer_url"))

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

        def _parse_payout_batch_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        payout_batch_id = _parse_payout_batch_id(d.pop("payout_batch_id"))

        def _parse_payout_status(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        payout_status = _parse_payout_status(d.pop("payout_status"))

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

        dispute_status_settlement = cls(
            rail=rail,
            outcome=outcome,
            failure=failure,
            paid_by=paid_by,
            refund_id=refund_id,
            tx_hash=tx_hash,
            explorer_url=explorer_url,
            ready_at=ready_at,
            payout_batch_id=payout_batch_id,
            payout_status=payout_status,
            settled_at=settled_at,
        )

        dispute_status_settlement.additional_properties = d
        return dispute_status_settlement

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
