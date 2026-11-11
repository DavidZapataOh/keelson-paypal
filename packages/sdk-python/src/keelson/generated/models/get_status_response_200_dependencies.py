from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.get_status_response_200_dependencies_db import (
    GetStatusResponse200DependenciesDb,
    check_get_status_response_200_dependencies_db,
)
from ..models.get_status_response_200_dependencies_kv import (
    GetStatusResponse200DependenciesKv,
    check_get_status_response_200_dependencies_kv,
)
from ..models.get_status_response_200_dependencies_tee_a import (
    GetStatusResponse200DependenciesTeeA,
    check_get_status_response_200_dependencies_tee_a,
)
from ..models.get_status_response_200_dependencies_tee_b import (
    GetStatusResponse200DependenciesTeeB,
    check_get_status_response_200_dependencies_tee_b,
)
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.get_status_response_200_dependencies_anchor import (
        GetStatusResponse200DependenciesAnchor,
    )
    from ..models.get_status_response_200_dependencies_chain_events import (
        GetStatusResponse200DependenciesChainEvents,
    )
    from ..models.get_status_response_200_dependencies_log import (
        GetStatusResponse200DependenciesLog,
    )
    from ..models.get_status_response_200_dependencies_paypal import (
        GetStatusResponse200DependenciesPaypal,
    )
    from ..models.get_status_response_200_dependencies_relayer import (
        GetStatusResponse200DependenciesRelayer,
    )
    from ..models.get_status_response_200_dependencies_webhooks import (
        GetStatusResponse200DependenciesWebhooks,
    )


T = TypeVar("T", bound="GetStatusResponse200Dependencies")


@_attrs_define
class GetStatusResponse200Dependencies:
    """
    Attributes:
        db (GetStatusResponse200DependenciesDb):
        kv (GetStatusResponse200DependenciesKv):
        tee_a (GetStatusResponse200DependenciesTeeA | Unset):
        tee_b (GetStatusResponse200DependenciesTeeB | Unset):
        relayer (GetStatusResponse200DependenciesRelayer | Unset):
        log (GetStatusResponse200DependenciesLog | Unset):
        paypal (GetStatusResponse200DependenciesPaypal | Unset):
        webhooks (GetStatusResponse200DependenciesWebhooks | Unset):
        chain_events (GetStatusResponse200DependenciesChainEvents | Unset):
        anchor (GetStatusResponse200DependenciesAnchor | Unset):
    """

    db: GetStatusResponse200DependenciesDb
    kv: GetStatusResponse200DependenciesKv
    tee_a: GetStatusResponse200DependenciesTeeA | Unset = UNSET
    tee_b: GetStatusResponse200DependenciesTeeB | Unset = UNSET
    relayer: GetStatusResponse200DependenciesRelayer | Unset = UNSET
    log: GetStatusResponse200DependenciesLog | Unset = UNSET
    paypal: GetStatusResponse200DependenciesPaypal | Unset = UNSET
    webhooks: GetStatusResponse200DependenciesWebhooks | Unset = UNSET
    chain_events: GetStatusResponse200DependenciesChainEvents | Unset = UNSET
    anchor: GetStatusResponse200DependenciesAnchor | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        db: str = self.db

        kv: str = self.kv

        tee_a: str | Unset = UNSET
        if not isinstance(self.tee_a, Unset):
            tee_a = self.tee_a

        tee_b: str | Unset = UNSET
        if not isinstance(self.tee_b, Unset):
            tee_b = self.tee_b

        relayer: dict[str, Any] | Unset = UNSET
        if not isinstance(self.relayer, Unset):
            relayer = self.relayer.to_dict()

        log: dict[str, Any] | Unset = UNSET
        if not isinstance(self.log, Unset):
            log = self.log.to_dict()

        paypal: dict[str, Any] | Unset = UNSET
        if not isinstance(self.paypal, Unset):
            paypal = self.paypal.to_dict()

        webhooks: dict[str, Any] | Unset = UNSET
        if not isinstance(self.webhooks, Unset):
            webhooks = self.webhooks.to_dict()

        chain_events: dict[str, Any] | Unset = UNSET
        if not isinstance(self.chain_events, Unset):
            chain_events = self.chain_events.to_dict()

        anchor: dict[str, Any] | Unset = UNSET
        if not isinstance(self.anchor, Unset):
            anchor = self.anchor.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "db": db,
                "kv": kv,
            }
        )
        if tee_a is not UNSET:
            field_dict["teeA"] = tee_a
        if tee_b is not UNSET:
            field_dict["teeB"] = tee_b
        if relayer is not UNSET:
            field_dict["relayer"] = relayer
        if log is not UNSET:
            field_dict["log"] = log
        if paypal is not UNSET:
            field_dict["paypal"] = paypal
        if webhooks is not UNSET:
            field_dict["webhooks"] = webhooks
        if chain_events is not UNSET:
            field_dict["chainEvents"] = chain_events
        if anchor is not UNSET:
            field_dict["anchor"] = anchor

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.get_status_response_200_dependencies_anchor import (
            GetStatusResponse200DependenciesAnchor,
        )
        from ..models.get_status_response_200_dependencies_chain_events import (
            GetStatusResponse200DependenciesChainEvents,
        )
        from ..models.get_status_response_200_dependencies_log import (
            GetStatusResponse200DependenciesLog,
        )
        from ..models.get_status_response_200_dependencies_paypal import (
            GetStatusResponse200DependenciesPaypal,
        )
        from ..models.get_status_response_200_dependencies_relayer import (
            GetStatusResponse200DependenciesRelayer,
        )
        from ..models.get_status_response_200_dependencies_webhooks import (
            GetStatusResponse200DependenciesWebhooks,
        )

        d = dict(src_dict)
        db = check_get_status_response_200_dependencies_db(d.pop("db"))

        kv = check_get_status_response_200_dependencies_kv(d.pop("kv"))

        _tee_a = d.pop("teeA", UNSET)
        tee_a: GetStatusResponse200DependenciesTeeA | Unset
        if isinstance(_tee_a, Unset):
            tee_a = UNSET
        else:
            tee_a = check_get_status_response_200_dependencies_tee_a(_tee_a)

        _tee_b = d.pop("teeB", UNSET)
        tee_b: GetStatusResponse200DependenciesTeeB | Unset
        if isinstance(_tee_b, Unset):
            tee_b = UNSET
        else:
            tee_b = check_get_status_response_200_dependencies_tee_b(_tee_b)

        _relayer = d.pop("relayer", UNSET)
        relayer: GetStatusResponse200DependenciesRelayer | Unset
        if isinstance(_relayer, Unset):
            relayer = UNSET
        else:
            relayer = GetStatusResponse200DependenciesRelayer.from_dict(_relayer)

        _log = d.pop("log", UNSET)
        log: GetStatusResponse200DependenciesLog | Unset
        if isinstance(_log, Unset):
            log = UNSET
        else:
            log = GetStatusResponse200DependenciesLog.from_dict(_log)

        _paypal = d.pop("paypal", UNSET)
        paypal: GetStatusResponse200DependenciesPaypal | Unset
        if isinstance(_paypal, Unset):
            paypal = UNSET
        else:
            paypal = GetStatusResponse200DependenciesPaypal.from_dict(_paypal)

        _webhooks = d.pop("webhooks", UNSET)
        webhooks: GetStatusResponse200DependenciesWebhooks | Unset
        if isinstance(_webhooks, Unset):
            webhooks = UNSET
        else:
            webhooks = GetStatusResponse200DependenciesWebhooks.from_dict(_webhooks)

        _chain_events = d.pop("chainEvents", UNSET)
        chain_events: GetStatusResponse200DependenciesChainEvents | Unset
        if isinstance(_chain_events, Unset):
            chain_events = UNSET
        else:
            chain_events = GetStatusResponse200DependenciesChainEvents.from_dict(_chain_events)

        _anchor = d.pop("anchor", UNSET)
        anchor: GetStatusResponse200DependenciesAnchor | Unset
        if isinstance(_anchor, Unset):
            anchor = UNSET
        else:
            anchor = GetStatusResponse200DependenciesAnchor.from_dict(_anchor)

        get_status_response_200_dependencies = cls(
            db=db,
            kv=kv,
            tee_a=tee_a,
            tee_b=tee_b,
            relayer=relayer,
            log=log,
            paypal=paypal,
            webhooks=webhooks,
            chain_events=chain_events,
            anchor=anchor,
        )

        get_status_response_200_dependencies.additional_properties = d
        return get_status_response_200_dependencies

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
