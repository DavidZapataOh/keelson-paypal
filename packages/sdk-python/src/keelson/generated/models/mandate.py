from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.mandate_rail import MandateRail, check_mandate_rail
from ..models.mandate_state import MandateState, check_mandate_state

if TYPE_CHECKING:
    from ..models.mandate_budget import MandateBudget
    from ..models.mandate_card import MandateCard
    from ..models.mandate_hold import MandateHold
    from ..models.mandate_purchase import MandatePurchase
    from ..models.pending_purchase_hold import PendingPurchaseHold


T = TypeVar("T", bound="Mandate")


@_attrs_define
class Mandate:
    """
    Attributes:
        id (str):
        state (MandateState):
        rail (MandateRail): `card` when each purchase is paid with its own single-use card.
        mandate_hash (None | str):
        budget (MandateBudget): The mandate's budget and what is left of it, in minor units.
        expires_at (datetime.datetime):
        hold (MandateHold | None): The PayPal hold of the mandate's budget, once its order exists.
        card (MandateCard | None): The card rendered from the stored payload, before any checkout evidence.
        purchases (list[MandatePurchase]): The mandate's latest 100 purchases, newest first.
        pending_holds (list[PendingPurchaseHold]): Purchase holds of a several-store mandate still waiting for the
            buyer's PayPal approval, oldest first. Later changes arrive as `mandate.purchase_hold` events.
    """

    id: str
    state: MandateState
    rail: MandateRail
    mandate_hash: str | None
    budget: MandateBudget
    expires_at: datetime.datetime
    hold: MandateHold | None
    card: MandateCard | None
    purchases: list[MandatePurchase]
    pending_holds: list[PendingPurchaseHold]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.mandate_card import MandateCard
        from ..models.mandate_hold import MandateHold

        id = self.id

        state: str = self.state

        rail: str = self.rail

        mandate_hash: str | None
        mandate_hash = self.mandate_hash

        budget = self.budget.to_dict()

        expires_at = self.expires_at.isoformat()

        hold: dict[str, Any] | None
        if isinstance(self.hold, MandateHold):
            hold = self.hold.to_dict()
        else:
            hold = self.hold

        card: dict[str, Any] | None
        if isinstance(self.card, MandateCard):
            card = self.card.to_dict()
        else:
            card = self.card

        purchases = []
        for purchases_item_data in self.purchases:
            purchases_item = purchases_item_data.to_dict()
            purchases.append(purchases_item)

        pending_holds = []
        for pending_holds_item_data in self.pending_holds:
            pending_holds_item = pending_holds_item_data.to_dict()
            pending_holds.append(pending_holds_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "state": state,
                "rail": rail,
                "mandateHash": mandate_hash,
                "budget": budget,
                "expiresAt": expires_at,
                "hold": hold,
                "card": card,
                "purchases": purchases,
                "pendingHolds": pending_holds,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_budget import MandateBudget
        from ..models.mandate_card import MandateCard
        from ..models.mandate_hold import MandateHold
        from ..models.mandate_purchase import MandatePurchase
        from ..models.pending_purchase_hold import PendingPurchaseHold

        d = dict(src_dict)
        id = d.pop("id")

        state = check_mandate_state(d.pop("state"))

        rail = check_mandate_rail(d.pop("rail"))

        def _parse_mandate_hash(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        mandate_hash = _parse_mandate_hash(d.pop("mandateHash"))

        budget = MandateBudget.from_dict(d.pop("budget"))

        expires_at = datetime.datetime.fromisoformat(d.pop("expiresAt"))

        def _parse_hold(data: object) -> MandateHold | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                hold_type_0 = MandateHold.from_dict(data)

                return hold_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(MandateHold | None, data)

        hold = _parse_hold(d.pop("hold"))

        def _parse_card(data: object) -> MandateCard | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                card_type_0 = MandateCard.from_dict(data)

                return card_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(MandateCard | None, data)

        card = _parse_card(d.pop("card"))

        purchases = []
        _purchases = d.pop("purchases")
        for purchases_item_data in _purchases:
            purchases_item = MandatePurchase.from_dict(purchases_item_data)

            purchases.append(purchases_item)

        pending_holds = []
        _pending_holds = d.pop("pendingHolds")
        for pending_holds_item_data in _pending_holds:
            pending_holds_item = PendingPurchaseHold.from_dict(pending_holds_item_data)

            pending_holds.append(pending_holds_item)

        mandate = cls(
            id=id,
            state=state,
            rail=rail,
            mandate_hash=mandate_hash,
            budget=budget,
            expires_at=expires_at,
            hold=hold,
            card=card,
            purchases=purchases,
            pending_holds=pending_holds,
        )

        mandate.additional_properties = d
        return mandate

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
