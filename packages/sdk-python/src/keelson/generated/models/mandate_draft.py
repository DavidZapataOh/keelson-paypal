from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_mode import MandateDraftMode, check_mandate_draft_mode
from ..models.mandate_draft_v import MandateDraftV, check_mandate_draft_v
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.mandate_draft_agent import MandateDraftAgent
    from ..models.mandate_draft_checkout import MandateDraftCheckout
    from ..models.mandate_draft_consent import MandateDraftConsent
    from ..models.mandate_draft_embed import MandateDraftEmbed
    from ..models.mandate_draft_intent import MandateDraftIntent
    from ..models.mandate_draft_payment import MandateDraftPayment
    from ..models.mandate_draft_policy import MandateDraftPolicy
    from ..models.mandate_draft_risk_data import MandateDraftRiskData
    from ..models.mandate_draft_user import MandateDraftUser
    from ..models.mandate_draft_zk import MandateDraftZk


T = TypeVar("T", bound="MandateDraft")


@_attrs_define
class MandateDraft:
    """The compiled `keelson.mandate.1` payload, unsigned; its commitment is zero.

    Attributes:
        v (MandateDraftV):
        mid (str):
        iat (int):
        nbf (int):
        exp (int):
        nonce (str):
        mode (MandateDraftMode):
        user (MandateDraftUser):
        agent (MandateDraftAgent):
        payment (MandateDraftPayment):
        checkout (MandateDraftCheckout):
        intent (MandateDraftIntent):
        policy (MandateDraftPolicy):
        consent (MandateDraftConsent):
        zk (MandateDraftZk):
        risk_data (MandateDraftRiskData):
        embed (MandateDraftEmbed | Unset):
    """

    v: MandateDraftV
    mid: str
    iat: int
    nbf: int
    exp: int
    nonce: str
    mode: MandateDraftMode
    user: MandateDraftUser
    agent: MandateDraftAgent
    payment: MandateDraftPayment
    checkout: MandateDraftCheckout
    intent: MandateDraftIntent
    policy: MandateDraftPolicy
    consent: MandateDraftConsent
    zk: MandateDraftZk
    risk_data: MandateDraftRiskData
    embed: MandateDraftEmbed | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        v: str = self.v

        mid = self.mid

        iat = self.iat

        nbf = self.nbf

        exp = self.exp

        nonce = self.nonce

        mode: str = self.mode

        user = self.user.to_dict()

        agent = self.agent.to_dict()

        payment = self.payment.to_dict()

        checkout = self.checkout.to_dict()

        intent = self.intent.to_dict()

        policy = self.policy.to_dict()

        consent = self.consent.to_dict()

        zk = self.zk.to_dict()

        risk_data = self.risk_data.to_dict()

        embed: dict[str, Any] | Unset = UNSET
        if not isinstance(self.embed, Unset):
            embed = self.embed.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "v": v,
                "mid": mid,
                "iat": iat,
                "nbf": nbf,
                "exp": exp,
                "nonce": nonce,
                "mode": mode,
                "user": user,
                "agent": agent,
                "payment": payment,
                "checkout": checkout,
                "intent": intent,
                "policy": policy,
                "consent": consent,
                "zk": zk,
                "risk_data": risk_data,
            }
        )
        if embed is not UNSET:
            field_dict["embed"] = embed

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_draft_agent import MandateDraftAgent
        from ..models.mandate_draft_checkout import MandateDraftCheckout
        from ..models.mandate_draft_consent import MandateDraftConsent
        from ..models.mandate_draft_embed import MandateDraftEmbed
        from ..models.mandate_draft_intent import MandateDraftIntent
        from ..models.mandate_draft_payment import MandateDraftPayment
        from ..models.mandate_draft_policy import MandateDraftPolicy
        from ..models.mandate_draft_risk_data import MandateDraftRiskData
        from ..models.mandate_draft_user import MandateDraftUser
        from ..models.mandate_draft_zk import MandateDraftZk

        d = dict(src_dict)
        v = check_mandate_draft_v(d.pop("v"))

        mid = d.pop("mid")

        iat = d.pop("iat")

        nbf = d.pop("nbf")

        exp = d.pop("exp")

        nonce = d.pop("nonce")

        mode = check_mandate_draft_mode(d.pop("mode"))

        user = MandateDraftUser.from_dict(d.pop("user"))

        agent = MandateDraftAgent.from_dict(d.pop("agent"))

        payment = MandateDraftPayment.from_dict(d.pop("payment"))

        checkout = MandateDraftCheckout.from_dict(d.pop("checkout"))

        intent = MandateDraftIntent.from_dict(d.pop("intent"))

        policy = MandateDraftPolicy.from_dict(d.pop("policy"))

        consent = MandateDraftConsent.from_dict(d.pop("consent"))

        zk = MandateDraftZk.from_dict(d.pop("zk"))

        risk_data = MandateDraftRiskData.from_dict(d.pop("risk_data"))

        _embed = d.pop("embed", UNSET)
        embed: MandateDraftEmbed | Unset
        if isinstance(_embed, Unset):
            embed = UNSET
        else:
            embed = MandateDraftEmbed.from_dict(_embed)

        mandate_draft = cls(
            v=v,
            mid=mid,
            iat=iat,
            nbf=nbf,
            exp=exp,
            nonce=nonce,
            mode=mode,
            user=user,
            agent=agent,
            payment=payment,
            checkout=checkout,
            intent=intent,
            policy=policy,
            consent=consent,
            zk=zk,
            risk_data=risk_data,
            embed=embed,
        )

        return mandate_draft
