from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.compile_mandate_mode import CompileMandateMode, check_compile_mandate_mode
from ..types import UNSET, Unset

T = TypeVar("T", bound="CompileMandate")


@_attrs_define
class CompileMandate:
    """
    Attributes:
        prompt (str): The shopping request in natural language, at most 2000 UTF-16 code units. Example: Running shoes,
            size 10, under $100, free returns, by Friday.
        credential_id (str | Unset): The passkey that will sign the mandate; defaults to the most recent one.
        mode (CompileMandateMode | Unset): Whether the user is present at checkout (`immediate`) or not (`autonomous`).
            Default: 'autonomous'.
    """

    prompt: str
    credential_id: str | Unset = UNSET
    mode: CompileMandateMode | Unset = "autonomous"
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        prompt = self.prompt

        credential_id = self.credential_id

        mode: str | Unset = UNSET
        if not isinstance(self.mode, Unset):
            mode = self.mode

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "prompt": prompt,
            }
        )
        if credential_id is not UNSET:
            field_dict["credentialId"] = credential_id
        if mode is not UNSET:
            field_dict["mode"] = mode

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        prompt = d.pop("prompt")

        credential_id = d.pop("credentialId", UNSET)

        _mode = d.pop("mode", UNSET)
        mode: CompileMandateMode | Unset
        if isinstance(_mode, Unset):
            mode = UNSET
        else:
            mode = check_compile_mandate_mode(_mode)

        compile_mandate = cls(
            prompt=prompt,
            credential_id=credential_id,
            mode=mode,
        )

        compile_mandate.additional_properties = d
        return compile_mandate

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
