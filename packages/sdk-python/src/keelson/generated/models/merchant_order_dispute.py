from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.merchant_order_dispute_liable_type_1 import (
    MerchantOrderDisputeLiableType1,
    check_merchant_order_dispute_liable_type_1,
)
from ..models.merchant_order_dispute_liable_type_2_type_1 import (
    MerchantOrderDisputeLiableType2Type1,
    check_merchant_order_dispute_liable_type_2_type_1,
)
from ..models.merchant_order_dispute_liable_type_3_type_1 import (
    MerchantOrderDisputeLiableType3Type1,
    check_merchant_order_dispute_liable_type_3_type_1,
)
from ..models.merchant_order_dispute_state import (
    MerchantOrderDisputeState,
    check_merchant_order_dispute_state,
)

T = TypeVar("T", bound="MerchantOrderDispute")


@_attrs_define
class MerchantOrderDispute:
    """
    Attributes:
        dispute_id (str):
        state (MerchantOrderDisputeState):
        liable (MerchantOrderDisputeLiableType1 | MerchantOrderDisputeLiableType2Type1 |
            MerchantOrderDisputeLiableType3Type1 | None):
    """

    dispute_id: str
    state: MerchantOrderDisputeState
    liable: (
        MerchantOrderDisputeLiableType1
        | MerchantOrderDisputeLiableType2Type1
        | MerchantOrderDisputeLiableType3Type1
        | None
    )
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        dispute_id = self.dispute_id

        state: str = self.state

        liable: str | None
        if (
            isinstance(self.liable, str)
            or isinstance(self.liable, str)
            or isinstance(self.liable, str)
        ):
            liable = self.liable
        else:
            liable = self.liable

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "dispute_id": dispute_id,
                "state": state,
                "liable": liable,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        dispute_id = d.pop("dispute_id")

        state = check_merchant_order_dispute_state(d.pop("state"))

        def _parse_liable(
            data: object,
        ) -> (
            MerchantOrderDisputeLiableType1
            | MerchantOrderDisputeLiableType2Type1
            | MerchantOrderDisputeLiableType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                liable_type_1 = check_merchant_order_dispute_liable_type_1(data)

                return liable_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                liable_type_2_type_1 = check_merchant_order_dispute_liable_type_2_type_1(data)

                return liable_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                liable_type_3_type_1 = check_merchant_order_dispute_liable_type_3_type_1(data)

                return liable_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                MerchantOrderDisputeLiableType1
                | MerchantOrderDisputeLiableType2Type1
                | MerchantOrderDisputeLiableType3Type1
                | None,
                data,
            )

        liable = _parse_liable(d.pop("liable"))

        merchant_order_dispute = cls(
            dispute_id=dispute_id,
            state=state,
            liable=liable,
        )

        merchant_order_dispute.additional_properties = d
        return merchant_order_dispute

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
