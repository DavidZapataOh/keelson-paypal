from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.log_bond_withdrawal import LogBondWithdrawal
    from ..models.log_equivocation import LogEquivocation


T = TypeVar("T", bound="LogBond")


@_attrs_define
class LogBond:
    """
    Attributes:
        chain_id (float):
        address (str):
        origin (str):
        test (bool): A test origin's bond, slashed by the equivocation drill.
        key (str): The Ed25519 log key the bond pins, hex.
        owner (str):
        verifier (str): The Ed25519 verifier the bond calls.
        canonical (bool): Whether the bond calls the registry's `Ed25519Verifier` over PYUSD. A bond on another verifier
            or token proves nothing.
        beneficiary (str): Who receives a slash, less the bounty.
        bounty_bps (float):
        completion_window_seconds (float):
        balance_minor (str):
        withdrawal_delay_seconds (float):
        withdrawal (LogBondWithdrawal | None):
        equivocation (LogEquivocation | None):
        explorer_url (str):
    """

    chain_id: float
    address: str
    origin: str
    test: bool
    key: str
    owner: str
    verifier: str
    canonical: bool
    beneficiary: str
    bounty_bps: float
    completion_window_seconds: float
    balance_minor: str
    withdrawal_delay_seconds: float
    withdrawal: LogBondWithdrawal | None
    equivocation: LogEquivocation | None
    explorer_url: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.log_bond_withdrawal import LogBondWithdrawal
        from ..models.log_equivocation import LogEquivocation

        chain_id = self.chain_id

        address = self.address

        origin = self.origin

        test = self.test

        key = self.key

        owner = self.owner

        verifier = self.verifier

        canonical = self.canonical

        beneficiary = self.beneficiary

        bounty_bps = self.bounty_bps

        completion_window_seconds = self.completion_window_seconds

        balance_minor = self.balance_minor

        withdrawal_delay_seconds = self.withdrawal_delay_seconds

        withdrawal: dict[str, Any] | None
        if isinstance(self.withdrawal, LogBondWithdrawal):
            withdrawal = self.withdrawal.to_dict()
        else:
            withdrawal = self.withdrawal

        equivocation: dict[str, Any] | None
        if isinstance(self.equivocation, LogEquivocation):
            equivocation = self.equivocation.to_dict()
        else:
            equivocation = self.equivocation

        explorer_url = self.explorer_url

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chainId": chain_id,
                "address": address,
                "origin": origin,
                "test": test,
                "key": key,
                "owner": owner,
                "verifier": verifier,
                "canonical": canonical,
                "beneficiary": beneficiary,
                "bountyBps": bounty_bps,
                "completionWindowSeconds": completion_window_seconds,
                "balanceMinor": balance_minor,
                "withdrawalDelaySeconds": withdrawal_delay_seconds,
                "withdrawal": withdrawal,
                "equivocation": equivocation,
                "explorerUrl": explorer_url,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.log_bond_withdrawal import LogBondWithdrawal
        from ..models.log_equivocation import LogEquivocation

        d = dict(src_dict)
        chain_id = d.pop("chainId")

        address = d.pop("address")

        origin = d.pop("origin")

        test = d.pop("test")

        key = d.pop("key")

        owner = d.pop("owner")

        verifier = d.pop("verifier")

        canonical = d.pop("canonical")

        beneficiary = d.pop("beneficiary")

        bounty_bps = d.pop("bountyBps")

        completion_window_seconds = d.pop("completionWindowSeconds")

        balance_minor = d.pop("balanceMinor")

        withdrawal_delay_seconds = d.pop("withdrawalDelaySeconds")

        def _parse_withdrawal(data: object) -> LogBondWithdrawal | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                withdrawal_type_0 = LogBondWithdrawal.from_dict(data)

                return withdrawal_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(LogBondWithdrawal | None, data)

        withdrawal = _parse_withdrawal(d.pop("withdrawal"))

        def _parse_equivocation(data: object) -> LogEquivocation | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                equivocation_type_0 = LogEquivocation.from_dict(data)

                return equivocation_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(LogEquivocation | None, data)

        equivocation = _parse_equivocation(d.pop("equivocation"))

        explorer_url = d.pop("explorerUrl")

        log_bond = cls(
            chain_id=chain_id,
            address=address,
            origin=origin,
            test=test,
            key=key,
            owner=owner,
            verifier=verifier,
            canonical=canonical,
            beneficiary=beneficiary,
            bounty_bps=bounty_bps,
            completion_window_seconds=completion_window_seconds,
            balance_minor=balance_minor,
            withdrawal_delay_seconds=withdrawal_delay_seconds,
            withdrawal=withdrawal,
            equivocation=equivocation,
            explorer_url=explorer_url,
        )

        log_bond.additional_properties = d
        return log_bond

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
