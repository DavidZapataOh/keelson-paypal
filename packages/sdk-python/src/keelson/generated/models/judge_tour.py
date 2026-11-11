from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.judge_tour_anonymous_purchase import JudgeTourAnonymousPurchase
    from ..models.judge_tour_mandate import JudgeTourMandate


T = TypeVar("T", bound="JudgeTour")


@_attrs_define
class JudgeTour:
    """
    Attributes:
        merchant_id (str):
        agent_id (None | str):
        mandate (JudgeTourMandate | None):
        anonymous_purchase (JudgeTourAnonymousPurchase | None): The newest test purchase whose C1 and C3 proofs are
            composed into one anonymous proof, served at `GET /v1/anonymous-purchases/{id}`.
        dispute_id (None | str):
        campaign_id (None | str):
    """

    merchant_id: str
    agent_id: str | None
    mandate: JudgeTourMandate | None
    anonymous_purchase: JudgeTourAnonymousPurchase | None
    dispute_id: str | None
    campaign_id: str | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.judge_tour_anonymous_purchase import JudgeTourAnonymousPurchase
        from ..models.judge_tour_mandate import JudgeTourMandate

        merchant_id = self.merchant_id

        agent_id: str | None
        agent_id = self.agent_id

        mandate: dict[str, Any] | None
        if isinstance(self.mandate, JudgeTourMandate):
            mandate = self.mandate.to_dict()
        else:
            mandate = self.mandate

        anonymous_purchase: dict[str, Any] | None
        if isinstance(self.anonymous_purchase, JudgeTourAnonymousPurchase):
            anonymous_purchase = self.anonymous_purchase.to_dict()
        else:
            anonymous_purchase = self.anonymous_purchase

        dispute_id: str | None
        dispute_id = self.dispute_id

        campaign_id: str | None
        campaign_id = self.campaign_id

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "merchant_id": merchant_id,
                "agent_id": agent_id,
                "mandate": mandate,
                "anonymous_purchase": anonymous_purchase,
                "dispute_id": dispute_id,
                "campaign_id": campaign_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.judge_tour_anonymous_purchase import JudgeTourAnonymousPurchase
        from ..models.judge_tour_mandate import JudgeTourMandate

        d = dict(src_dict)
        merchant_id = d.pop("merchant_id")

        def _parse_agent_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        agent_id = _parse_agent_id(d.pop("agent_id"))

        def _parse_mandate(data: object) -> JudgeTourMandate | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                mandate_type_0 = JudgeTourMandate.from_dict(data)

                return mandate_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(JudgeTourMandate | None, data)

        mandate = _parse_mandate(d.pop("mandate"))

        def _parse_anonymous_purchase(data: object) -> JudgeTourAnonymousPurchase | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                anonymous_purchase_type_0 = JudgeTourAnonymousPurchase.from_dict(data)

                return anonymous_purchase_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(JudgeTourAnonymousPurchase | None, data)

        anonymous_purchase = _parse_anonymous_purchase(d.pop("anonymous_purchase"))

        def _parse_dispute_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        dispute_id = _parse_dispute_id(d.pop("dispute_id"))

        def _parse_campaign_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        campaign_id = _parse_campaign_id(d.pop("campaign_id"))

        judge_tour = cls(
            merchant_id=merchant_id,
            agent_id=agent_id,
            mandate=mandate,
            anonymous_purchase=anonymous_purchase,
            dispute_id=dispute_id,
            campaign_id=campaign_id,
        )

        judge_tour.additional_properties = d
        return judge_tour

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
