from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.connection_kind import ConnectionKind, check_connection_kind
from ..models.connection_state import ConnectionState, check_connection_state

if TYPE_CHECKING:
    from ..models.connection_agent import ConnectionAgent
    from ..models.connection_cart import ConnectionCart
    from ..models.connection_checks_type_0_item import ConnectionChecksType0Item
    from ..models.connection_limits_detail import ConnectionLimitsDetail
    from ..models.connection_match import ConnectionMatch
    from ..models.connection_parent import ConnectionParent


T = TypeVar("T", bound="Connection")


@_attrs_define
class Connection:
    """
    Attributes:
        code (str):
        kind (ConnectionKind): `connect`: standing limits. `once`: one cart its mandate does not allow. `change`: new
            limits that replace `parent`, whose hold is released.
        state (ConnectionState):
        name (str):
        reason (str):
        agent (ConnectionAgent):
        limits (ConnectionLimitsDetail):
        parent (ConnectionParent | None):
        mandate_id (None | str):
        cart (ConnectionCart | None): For `once`: the cart the agent tried, as it saw it.
        checks (list[ConnectionChecksType0Item] | None): For `once`: each mandate field against the cart; the failing
            ones are why it is paused. `askAbove` fails when the cart is above the user's ask-me amount.
        match (ConnectionMatch | None): When the user must pick the agent's number before approving: three numbers, one
            the agent shows. Null when the request needs no match.
        expires_at (str):
        created_at (str):
    """

    code: str
    kind: ConnectionKind
    state: ConnectionState
    name: str
    reason: str
    agent: ConnectionAgent
    limits: ConnectionLimitsDetail
    parent: ConnectionParent | None
    mandate_id: str | None
    cart: ConnectionCart | None
    checks: list[ConnectionChecksType0Item] | None
    match: ConnectionMatch | None
    expires_at: str
    created_at: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.connection_cart import ConnectionCart
        from ..models.connection_match import ConnectionMatch
        from ..models.connection_parent import ConnectionParent

        code = self.code

        kind: str = self.kind

        state: str = self.state

        name = self.name

        reason = self.reason

        agent = self.agent.to_dict()

        limits = self.limits.to_dict()

        parent: dict[str, Any] | None
        if isinstance(self.parent, ConnectionParent):
            parent = self.parent.to_dict()
        else:
            parent = self.parent

        mandate_id: str | None
        mandate_id = self.mandate_id

        cart: dict[str, Any] | None
        if isinstance(self.cart, ConnectionCart):
            cart = self.cart.to_dict()
        else:
            cart = self.cart

        checks: list[dict[str, Any]] | None
        if isinstance(self.checks, list):
            checks = []
            for checks_type_0_item_data in self.checks:
                checks_type_0_item = checks_type_0_item_data.to_dict()
                checks.append(checks_type_0_item)

        else:
            checks = self.checks

        match: dict[str, Any] | None
        if isinstance(self.match, ConnectionMatch):
            match = self.match.to_dict()
        else:
            match = self.match

        expires_at = self.expires_at

        created_at = self.created_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "code": code,
                "kind": kind,
                "state": state,
                "name": name,
                "reason": reason,
                "agent": agent,
                "limits": limits,
                "parent": parent,
                "mandateId": mandate_id,
                "cart": cart,
                "checks": checks,
                "match": match,
                "expiresAt": expires_at,
                "createdAt": created_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.connection_agent import ConnectionAgent
        from ..models.connection_cart import ConnectionCart
        from ..models.connection_checks_type_0_item import ConnectionChecksType0Item
        from ..models.connection_limits_detail import ConnectionLimitsDetail
        from ..models.connection_match import ConnectionMatch
        from ..models.connection_parent import ConnectionParent

        d = dict(src_dict)
        code = d.pop("code")

        kind = check_connection_kind(d.pop("kind"))

        state = check_connection_state(d.pop("state"))

        name = d.pop("name")

        reason = d.pop("reason")

        agent = ConnectionAgent.from_dict(d.pop("agent"))

        limits = ConnectionLimitsDetail.from_dict(d.pop("limits"))

        def _parse_parent(data: object) -> ConnectionParent | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                parent_type_0 = ConnectionParent.from_dict(data)

                return parent_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(ConnectionParent | None, data)

        parent = _parse_parent(d.pop("parent"))

        def _parse_mandate_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        mandate_id = _parse_mandate_id(d.pop("mandateId"))

        def _parse_cart(data: object) -> ConnectionCart | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                cart_type_0 = ConnectionCart.from_dict(data)

                return cart_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(ConnectionCart | None, data)

        cart = _parse_cart(d.pop("cart"))

        def _parse_checks(data: object) -> list[ConnectionChecksType0Item] | None:
            if data is None:
                return data
            try:
                if not isinstance(data, list):
                    raise TypeError()
                checks_type_0 = []
                _checks_type_0 = data
                for checks_type_0_item_data in _checks_type_0:
                    checks_type_0_item = ConnectionChecksType0Item.from_dict(
                        checks_type_0_item_data
                    )

                    checks_type_0.append(checks_type_0_item)

                return checks_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(list[ConnectionChecksType0Item] | None, data)

        checks = _parse_checks(d.pop("checks"))

        def _parse_match(data: object) -> ConnectionMatch | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                match_type_0 = ConnectionMatch.from_dict(data)

                return match_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(ConnectionMatch | None, data)

        match = _parse_match(d.pop("match"))

        expires_at = d.pop("expiresAt")

        created_at = d.pop("createdAt")

        connection = cls(
            code=code,
            kind=kind,
            state=state,
            name=name,
            reason=reason,
            agent=agent,
            limits=limits,
            parent=parent,
            mandate_id=mandate_id,
            cart=cart,
            checks=checks,
            match=match,
            expires_at=expires_at,
            created_at=created_at,
        )

        connection.additional_properties = d
        return connection

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
