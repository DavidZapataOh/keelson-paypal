from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.transaction_status import TransactionStatus, check_transaction_status
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.transaction_error import TransactionError


T = TypeVar("T", bound="Transaction")


@_attrs_define
class Transaction:
    """A transaction the Keelson relayer sent and paid for.

    Attributes:
        id (str):
        chain_id (int):
        key (str): `<contract>.<function>:<natural id>`.
        contract (str):
        function_name (str):
        status (TransactionStatus):
        hash_ (str | Unset):
        nonce (str | Unset):
        block_number (str | Unset):
        block_hash (str | Unset):
        gas_used (str | Unset):
        effective_gas_price (str | Unset):
        latency_ms (int | Unset):
        error_code (str | Unset):
        error (TransactionError | Unset):
        explorer_url (str | Unset):
    """

    id: str
    chain_id: int
    key: str
    contract: str
    function_name: str
    status: TransactionStatus
    hash_: str | Unset = UNSET
    nonce: str | Unset = UNSET
    block_number: str | Unset = UNSET
    block_hash: str | Unset = UNSET
    gas_used: str | Unset = UNSET
    effective_gas_price: str | Unset = UNSET
    latency_ms: int | Unset = UNSET
    error_code: str | Unset = UNSET
    error: TransactionError | Unset = UNSET
    explorer_url: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        chain_id = self.chain_id

        key = self.key

        contract = self.contract

        function_name = self.function_name

        status: str = self.status

        hash_ = self.hash_

        nonce = self.nonce

        block_number = self.block_number

        block_hash = self.block_hash

        gas_used = self.gas_used

        effective_gas_price = self.effective_gas_price

        latency_ms = self.latency_ms

        error_code = self.error_code

        error: dict[str, Any] | Unset = UNSET
        if not isinstance(self.error, Unset):
            error = self.error.to_dict()

        explorer_url = self.explorer_url

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "chainId": chain_id,
                "key": key,
                "contract": contract,
                "functionName": function_name,
                "status": status,
            }
        )
        if hash_ is not UNSET:
            field_dict["hash"] = hash_
        if nonce is not UNSET:
            field_dict["nonce"] = nonce
        if block_number is not UNSET:
            field_dict["blockNumber"] = block_number
        if block_hash is not UNSET:
            field_dict["blockHash"] = block_hash
        if gas_used is not UNSET:
            field_dict["gasUsed"] = gas_used
        if effective_gas_price is not UNSET:
            field_dict["effectiveGasPrice"] = effective_gas_price
        if latency_ms is not UNSET:
            field_dict["latencyMs"] = latency_ms
        if error_code is not UNSET:
            field_dict["errorCode"] = error_code
        if error is not UNSET:
            field_dict["error"] = error
        if explorer_url is not UNSET:
            field_dict["explorerUrl"] = explorer_url

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.transaction_error import TransactionError

        d = dict(src_dict)
        id = d.pop("id")

        chain_id = d.pop("chainId")

        key = d.pop("key")

        contract = d.pop("contract")

        function_name = d.pop("functionName")

        status = check_transaction_status(d.pop("status"))

        hash_ = d.pop("hash", UNSET)

        nonce = d.pop("nonce", UNSET)

        block_number = d.pop("blockNumber", UNSET)

        block_hash = d.pop("blockHash", UNSET)

        gas_used = d.pop("gasUsed", UNSET)

        effective_gas_price = d.pop("effectiveGasPrice", UNSET)

        latency_ms = d.pop("latencyMs", UNSET)

        error_code = d.pop("errorCode", UNSET)

        _error = d.pop("error", UNSET)
        error: TransactionError | Unset
        if isinstance(_error, Unset):
            error = UNSET
        else:
            error = TransactionError.from_dict(_error)

        explorer_url = d.pop("explorerUrl", UNSET)

        transaction = cls(
            id=id,
            chain_id=chain_id,
            key=key,
            contract=contract,
            function_name=function_name,
            status=status,
            hash_=hash_,
            nonce=nonce,
            block_number=block_number,
            block_hash=block_hash,
            gas_used=gas_used,
            effective_gas_price=effective_gas_price,
            latency_ms=latency_ms,
            error_code=error_code,
            error=error,
            explorer_url=explorer_url,
        )

        transaction.additional_properties = d
        return transaction

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
