from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.countersigned_decision import CountersignedDecision, check_countersigned_decision
from ..models.countersigned_mode import CountersignedMode, check_countersigned_mode
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.countersigned_capture import CountersignedCapture
    from ..models.countersigned_card import CountersignedCard
    from ..models.countersigned_checks_item import CountersignedChecksItem
    from ..models.countersigned_countersign import CountersignedCountersign
    from ..models.countersigned_coverage import CountersignedCoverage
    from ..models.countersigned_failure import CountersignedFailure
    from ..models.countersigned_live import CountersignedLive
    from ..models.countersigned_reasons_item import CountersignedReasonsItem
    from ..models.countersigned_signatures import CountersignedSignatures
    from ..models.countersigned_signers import CountersignedSigners
    from ..models.once_approval import OnceApproval


T = TypeVar("T", bound="Countersigned")


@_attrs_define
class Countersigned:
    """
    Attributes:
        purchase_id (str):
        mode (CountersignedMode): `degraded` when leg B was unreachable and only leg A signed.
        decision (CountersignedDecision):
        countersign (CountersignedCountersign): The EIP-712 `Countersign` message, as decimal strings.
        digest (str):
        signatures (CountersignedSignatures):
        signers (CountersignedSigners):
        trace (Any | Unset): The `keelson.eval/1` trace both legs signed over.
        approval (OnceApproval | Unset): On a deny for a cart over the mandate's amount or outside its merchants: the
            user was asked to approve this cart once. Poll `POST /v1/connections/token` with its `device_code`; the answer
            is a single-purchase mandate for exactly this cart.
        state (str | Unset): `CAPTURED` once logged, covered and captured; `FAILED` with `failure` when a step refused;
            `COUNTERSIGNED`, `LOGGED` or `COVERED` while a step is pending; `DENIED` for a DENY.
        log_index (str | Unset): The leaf's index in the Alibi log.
        coverage (CountersignedCoverage | Unset): The `lockCoverage` transaction of the operator's bond.
        capture (CountersignedCapture | Unset): The PayPal capture of the countersigned amount.
        failure (CountersignedFailure | Unset): The step that failed and why; nothing was captured.
        blocked (list[str] | Unset): For a `DENIED` cart, the mandate fields whose check failed.
        reasons (list[CountersignedReasonsItem] | Unset): For a `DENIED` cart, each failed field with what the mandate
            allowed and what the cart had, as text.
        checks (list[CountersignedChecksItem] | Unset): For a purchase the engine checked, each mandate field with what
            the mandate allowed, what the cart had and whether it held.
        card (CountersignedCard | Unset): A card purchase: its single-use card (never its number) and every
            authorization the card network sent it, with both legs' decision. `CAPTURED` once the merchant's capture
            settles.
        live (CountersignedLive | Unset): A purchase the buyer pays at the store's own checkout: the store's origin and
            the PayPal transaction id once the agent recorded it. Never covered nor captured.
    """

    purchase_id: str
    mode: CountersignedMode
    decision: CountersignedDecision
    countersign: CountersignedCountersign
    digest: str
    signatures: CountersignedSignatures
    signers: CountersignedSigners
    trace: Any | Unset = UNSET
    approval: OnceApproval | Unset = UNSET
    state: str | Unset = UNSET
    log_index: str | Unset = UNSET
    coverage: CountersignedCoverage | Unset = UNSET
    capture: CountersignedCapture | Unset = UNSET
    failure: CountersignedFailure | Unset = UNSET
    blocked: list[str] | Unset = UNSET
    reasons: list[CountersignedReasonsItem] | Unset = UNSET
    checks: list[CountersignedChecksItem] | Unset = UNSET
    card: CountersignedCard | Unset = UNSET
    live: CountersignedLive | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        purchase_id = self.purchase_id

        mode: str = self.mode

        decision: str = self.decision

        countersign = self.countersign.to_dict()

        digest = self.digest

        signatures = self.signatures.to_dict()

        signers = self.signers.to_dict()

        trace = self.trace

        approval: dict[str, Any] | Unset = UNSET
        if not isinstance(self.approval, Unset):
            approval = self.approval.to_dict()

        state = self.state

        log_index = self.log_index

        coverage: dict[str, Any] | Unset = UNSET
        if not isinstance(self.coverage, Unset):
            coverage = self.coverage.to_dict()

        capture: dict[str, Any] | Unset = UNSET
        if not isinstance(self.capture, Unset):
            capture = self.capture.to_dict()

        failure: dict[str, Any] | Unset = UNSET
        if not isinstance(self.failure, Unset):
            failure = self.failure.to_dict()

        blocked: list[str] | Unset = UNSET
        if not isinstance(self.blocked, Unset):
            blocked = self.blocked

        reasons: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.reasons, Unset):
            reasons = []
            for reasons_item_data in self.reasons:
                reasons_item = reasons_item_data.to_dict()
                reasons.append(reasons_item)

        checks: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.checks, Unset):
            checks = []
            for checks_item_data in self.checks:
                checks_item = checks_item_data.to_dict()
                checks.append(checks_item)

        card: dict[str, Any] | Unset = UNSET
        if not isinstance(self.card, Unset):
            card = self.card.to_dict()

        live: dict[str, Any] | Unset = UNSET
        if not isinstance(self.live, Unset):
            live = self.live.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "purchaseId": purchase_id,
                "mode": mode,
                "decision": decision,
                "countersign": countersign,
                "digest": digest,
                "signatures": signatures,
                "signers": signers,
            }
        )
        if trace is not UNSET:
            field_dict["trace"] = trace
        if approval is not UNSET:
            field_dict["approval"] = approval
        if state is not UNSET:
            field_dict["state"] = state
        if log_index is not UNSET:
            field_dict["logIndex"] = log_index
        if coverage is not UNSET:
            field_dict["coverage"] = coverage
        if capture is not UNSET:
            field_dict["capture"] = capture
        if failure is not UNSET:
            field_dict["failure"] = failure
        if blocked is not UNSET:
            field_dict["blocked"] = blocked
        if reasons is not UNSET:
            field_dict["reasons"] = reasons
        if checks is not UNSET:
            field_dict["checks"] = checks
        if card is not UNSET:
            field_dict["card"] = card
        if live is not UNSET:
            field_dict["live"] = live

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.countersigned_capture import CountersignedCapture
        from ..models.countersigned_card import CountersignedCard
        from ..models.countersigned_checks_item import CountersignedChecksItem
        from ..models.countersigned_countersign import CountersignedCountersign
        from ..models.countersigned_coverage import CountersignedCoverage
        from ..models.countersigned_failure import CountersignedFailure
        from ..models.countersigned_live import CountersignedLive
        from ..models.countersigned_reasons_item import CountersignedReasonsItem
        from ..models.countersigned_signatures import CountersignedSignatures
        from ..models.countersigned_signers import CountersignedSigners
        from ..models.once_approval import OnceApproval

        d = dict(src_dict)
        purchase_id = d.pop("purchaseId")

        mode = check_countersigned_mode(d.pop("mode"))

        decision = check_countersigned_decision(d.pop("decision"))

        countersign = CountersignedCountersign.from_dict(d.pop("countersign"))

        digest = d.pop("digest")

        signatures = CountersignedSignatures.from_dict(d.pop("signatures"))

        signers = CountersignedSigners.from_dict(d.pop("signers"))

        trace = d.pop("trace", UNSET)

        _approval = d.pop("approval", UNSET)
        approval: OnceApproval | Unset
        if isinstance(_approval, Unset):
            approval = UNSET
        else:
            approval = OnceApproval.from_dict(_approval)

        state = d.pop("state", UNSET)

        log_index = d.pop("logIndex", UNSET)

        _coverage = d.pop("coverage", UNSET)
        coverage: CountersignedCoverage | Unset
        if isinstance(_coverage, Unset):
            coverage = UNSET
        else:
            coverage = CountersignedCoverage.from_dict(_coverage)

        _capture = d.pop("capture", UNSET)
        capture: CountersignedCapture | Unset
        if isinstance(_capture, Unset):
            capture = UNSET
        else:
            capture = CountersignedCapture.from_dict(_capture)

        _failure = d.pop("failure", UNSET)
        failure: CountersignedFailure | Unset
        if isinstance(_failure, Unset):
            failure = UNSET
        else:
            failure = CountersignedFailure.from_dict(_failure)

        blocked = cast(list[str], d.pop("blocked", UNSET))

        _reasons = d.pop("reasons", UNSET)
        reasons: list[CountersignedReasonsItem] | Unset = UNSET
        if _reasons is not UNSET:
            reasons = []
            for reasons_item_data in _reasons:
                reasons_item = CountersignedReasonsItem.from_dict(reasons_item_data)

                reasons.append(reasons_item)

        _checks = d.pop("checks", UNSET)
        checks: list[CountersignedChecksItem] | Unset = UNSET
        if _checks is not UNSET:
            checks = []
            for checks_item_data in _checks:
                checks_item = CountersignedChecksItem.from_dict(checks_item_data)

                checks.append(checks_item)

        _card = d.pop("card", UNSET)
        card: CountersignedCard | Unset
        if isinstance(_card, Unset):
            card = UNSET
        else:
            card = CountersignedCard.from_dict(_card)

        _live = d.pop("live", UNSET)
        live: CountersignedLive | Unset
        if isinstance(_live, Unset):
            live = UNSET
        else:
            live = CountersignedLive.from_dict(_live)

        countersigned = cls(
            purchase_id=purchase_id,
            mode=mode,
            decision=decision,
            countersign=countersign,
            digest=digest,
            signatures=signatures,
            signers=signers,
            trace=trace,
            approval=approval,
            state=state,
            log_index=log_index,
            coverage=coverage,
            capture=capture,
            failure=failure,
            blocked=blocked,
            reasons=reasons,
            checks=checks,
            card=card,
            live=live,
        )

        countersigned.additional_properties = d
        return countersigned

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
