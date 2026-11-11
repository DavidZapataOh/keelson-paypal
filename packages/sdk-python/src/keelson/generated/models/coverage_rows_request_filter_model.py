from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.coverage_rows_request_filter_model_amber_type_0 import (
        CoverageRowsRequestFilterModelAmberType0,
    )
    from ..models.coverage_rows_request_filter_model_amber_type_1 import (
        CoverageRowsRequestFilterModelAmberType1,
    )
    from ..models.coverage_rows_request_filter_model_amber_type_2 import (
        CoverageRowsRequestFilterModelAmberType2,
    )
    from ..models.coverage_rows_request_filter_model_amber_type_3 import (
        CoverageRowsRequestFilterModelAmberType3,
    )
    from ..models.coverage_rows_request_filter_model_amber_type_4 import (
        CoverageRowsRequestFilterModelAmberType4,
    )
    from ..models.coverage_rows_request_filter_model_amount_type_0 import (
        CoverageRowsRequestFilterModelAmountType0,
    )
    from ..models.coverage_rows_request_filter_model_amount_type_1 import (
        CoverageRowsRequestFilterModelAmountType1,
    )
    from ..models.coverage_rows_request_filter_model_amount_type_2 import (
        CoverageRowsRequestFilterModelAmountType2,
    )
    from ..models.coverage_rows_request_filter_model_amount_type_3 import (
        CoverageRowsRequestFilterModelAmountType3,
    )
    from ..models.coverage_rows_request_filter_model_amount_type_4 import (
        CoverageRowsRequestFilterModelAmountType4,
    )
    from ..models.coverage_rows_request_filter_model_created_at_type_0 import (
        CoverageRowsRequestFilterModelCreatedAtType0,
    )
    from ..models.coverage_rows_request_filter_model_created_at_type_1 import (
        CoverageRowsRequestFilterModelCreatedAtType1,
    )
    from ..models.coverage_rows_request_filter_model_created_at_type_2 import (
        CoverageRowsRequestFilterModelCreatedAtType2,
    )
    from ..models.coverage_rows_request_filter_model_created_at_type_3 import (
        CoverageRowsRequestFilterModelCreatedAtType3,
    )
    from ..models.coverage_rows_request_filter_model_created_at_type_4 import (
        CoverageRowsRequestFilterModelCreatedAtType4,
    )
    from ..models.coverage_rows_request_filter_model_dispute_state_type_0 import (
        CoverageRowsRequestFilterModelDisputeStateType0,
    )
    from ..models.coverage_rows_request_filter_model_dispute_state_type_1 import (
        CoverageRowsRequestFilterModelDisputeStateType1,
    )
    from ..models.coverage_rows_request_filter_model_dispute_state_type_2 import (
        CoverageRowsRequestFilterModelDisputeStateType2,
    )
    from ..models.coverage_rows_request_filter_model_dispute_state_type_3 import (
        CoverageRowsRequestFilterModelDisputeStateType3,
    )
    from ..models.coverage_rows_request_filter_model_dispute_state_type_4 import (
        CoverageRowsRequestFilterModelDisputeStateType4,
    )
    from ..models.coverage_rows_request_filter_model_id_type_0 import (
        CoverageRowsRequestFilterModelIdType0,
    )
    from ..models.coverage_rows_request_filter_model_id_type_1 import (
        CoverageRowsRequestFilterModelIdType1,
    )
    from ..models.coverage_rows_request_filter_model_id_type_2 import (
        CoverageRowsRequestFilterModelIdType2,
    )
    from ..models.coverage_rows_request_filter_model_id_type_3 import (
        CoverageRowsRequestFilterModelIdType3,
    )
    from ..models.coverage_rows_request_filter_model_id_type_4 import (
        CoverageRowsRequestFilterModelIdType4,
    )
    from ..models.coverage_rows_request_filter_model_liable_type_0 import (
        CoverageRowsRequestFilterModelLiableType0,
    )
    from ..models.coverage_rows_request_filter_model_liable_type_1 import (
        CoverageRowsRequestFilterModelLiableType1,
    )
    from ..models.coverage_rows_request_filter_model_liable_type_2 import (
        CoverageRowsRequestFilterModelLiableType2,
    )
    from ..models.coverage_rows_request_filter_model_liable_type_3 import (
        CoverageRowsRequestFilterModelLiableType3,
    )
    from ..models.coverage_rows_request_filter_model_liable_type_4 import (
        CoverageRowsRequestFilterModelLiableType4,
    )
    from ..models.coverage_rows_request_filter_model_merchant_id_type_0 import (
        CoverageRowsRequestFilterModelMerchantIdType0,
    )
    from ..models.coverage_rows_request_filter_model_merchant_id_type_1 import (
        CoverageRowsRequestFilterModelMerchantIdType1,
    )
    from ..models.coverage_rows_request_filter_model_merchant_id_type_2 import (
        CoverageRowsRequestFilterModelMerchantIdType2,
    )
    from ..models.coverage_rows_request_filter_model_merchant_id_type_3 import (
        CoverageRowsRequestFilterModelMerchantIdType3,
    )
    from ..models.coverage_rows_request_filter_model_merchant_id_type_4 import (
        CoverageRowsRequestFilterModelMerchantIdType4,
    )
    from ..models.coverage_rows_request_filter_model_outcome_type_0 import (
        CoverageRowsRequestFilterModelOutcomeType0,
    )
    from ..models.coverage_rows_request_filter_model_outcome_type_1 import (
        CoverageRowsRequestFilterModelOutcomeType1,
    )
    from ..models.coverage_rows_request_filter_model_outcome_type_2 import (
        CoverageRowsRequestFilterModelOutcomeType2,
    )
    from ..models.coverage_rows_request_filter_model_outcome_type_3 import (
        CoverageRowsRequestFilterModelOutcomeType3,
    )
    from ..models.coverage_rows_request_filter_model_outcome_type_4 import (
        CoverageRowsRequestFilterModelOutcomeType4,
    )
    from ..models.coverage_rows_request_filter_model_paid_by_type_0 import (
        CoverageRowsRequestFilterModelPaidByType0,
    )
    from ..models.coverage_rows_request_filter_model_paid_by_type_1 import (
        CoverageRowsRequestFilterModelPaidByType1,
    )
    from ..models.coverage_rows_request_filter_model_paid_by_type_2 import (
        CoverageRowsRequestFilterModelPaidByType2,
    )
    from ..models.coverage_rows_request_filter_model_paid_by_type_3 import (
        CoverageRowsRequestFilterModelPaidByType3,
    )
    from ..models.coverage_rows_request_filter_model_paid_by_type_4 import (
        CoverageRowsRequestFilterModelPaidByType4,
    )
    from ..models.coverage_rows_request_filter_model_premium_bps_type_0 import (
        CoverageRowsRequestFilterModelPremiumBpsType0,
    )
    from ..models.coverage_rows_request_filter_model_premium_bps_type_1 import (
        CoverageRowsRequestFilterModelPremiumBpsType1,
    )
    from ..models.coverage_rows_request_filter_model_premium_bps_type_2 import (
        CoverageRowsRequestFilterModelPremiumBpsType2,
    )
    from ..models.coverage_rows_request_filter_model_premium_bps_type_3 import (
        CoverageRowsRequestFilterModelPremiumBpsType3,
    )
    from ..models.coverage_rows_request_filter_model_premium_bps_type_4 import (
        CoverageRowsRequestFilterModelPremiumBpsType4,
    )
    from ..models.coverage_rows_request_filter_model_premium_type_0 import (
        CoverageRowsRequestFilterModelPremiumType0,
    )
    from ..models.coverage_rows_request_filter_model_premium_type_1 import (
        CoverageRowsRequestFilterModelPremiumType1,
    )
    from ..models.coverage_rows_request_filter_model_premium_type_2 import (
        CoverageRowsRequestFilterModelPremiumType2,
    )
    from ..models.coverage_rows_request_filter_model_premium_type_3 import (
        CoverageRowsRequestFilterModelPremiumType3,
    )
    from ..models.coverage_rows_request_filter_model_premium_type_4 import (
        CoverageRowsRequestFilterModelPremiumType4,
    )
    from ..models.coverage_rows_request_filter_model_state_type_0 import (
        CoverageRowsRequestFilterModelStateType0,
    )
    from ..models.coverage_rows_request_filter_model_state_type_1 import (
        CoverageRowsRequestFilterModelStateType1,
    )
    from ..models.coverage_rows_request_filter_model_state_type_2 import (
        CoverageRowsRequestFilterModelStateType2,
    )
    from ..models.coverage_rows_request_filter_model_state_type_3 import (
        CoverageRowsRequestFilterModelStateType3,
    )
    from ..models.coverage_rows_request_filter_model_state_type_4 import (
        CoverageRowsRequestFilterModelStateType4,
    )


T = TypeVar("T", bound="CoverageRowsRequestFilterModel")


@_attrs_define
class CoverageRowsRequestFilterModel:
    """
    Attributes:
        id (CoverageRowsRequestFilterModelIdType0 | CoverageRowsRequestFilterModelIdType1 |
            CoverageRowsRequestFilterModelIdType2 | CoverageRowsRequestFilterModelIdType3 |
            CoverageRowsRequestFilterModelIdType4 | Unset):
        created_at (CoverageRowsRequestFilterModelCreatedAtType0 | CoverageRowsRequestFilterModelCreatedAtType1 |
            CoverageRowsRequestFilterModelCreatedAtType2 | CoverageRowsRequestFilterModelCreatedAtType3 |
            CoverageRowsRequestFilterModelCreatedAtType4 | Unset):
        merchant_id (CoverageRowsRequestFilterModelMerchantIdType0 | CoverageRowsRequestFilterModelMerchantIdType1 |
            CoverageRowsRequestFilterModelMerchantIdType2 | CoverageRowsRequestFilterModelMerchantIdType3 |
            CoverageRowsRequestFilterModelMerchantIdType4 | Unset):
        amount (CoverageRowsRequestFilterModelAmountType0 | CoverageRowsRequestFilterModelAmountType1 |
            CoverageRowsRequestFilterModelAmountType2 | CoverageRowsRequestFilterModelAmountType3 |
            CoverageRowsRequestFilterModelAmountType4 | Unset):
        premium_bps (CoverageRowsRequestFilterModelPremiumBpsType0 | CoverageRowsRequestFilterModelPremiumBpsType1 |
            CoverageRowsRequestFilterModelPremiumBpsType2 | CoverageRowsRequestFilterModelPremiumBpsType3 |
            CoverageRowsRequestFilterModelPremiumBpsType4 | Unset):
        premium (CoverageRowsRequestFilterModelPremiumType0 | CoverageRowsRequestFilterModelPremiumType1 |
            CoverageRowsRequestFilterModelPremiumType2 | CoverageRowsRequestFilterModelPremiumType3 |
            CoverageRowsRequestFilterModelPremiumType4 | Unset):
        state (CoverageRowsRequestFilterModelStateType0 | CoverageRowsRequestFilterModelStateType1 |
            CoverageRowsRequestFilterModelStateType2 | CoverageRowsRequestFilterModelStateType3 |
            CoverageRowsRequestFilterModelStateType4 | Unset):
        dispute_state (CoverageRowsRequestFilterModelDisputeStateType0 | CoverageRowsRequestFilterModelDisputeStateType1
            | CoverageRowsRequestFilterModelDisputeStateType2 | CoverageRowsRequestFilterModelDisputeStateType3 |
            CoverageRowsRequestFilterModelDisputeStateType4 | Unset):
        liable (CoverageRowsRequestFilterModelLiableType0 | CoverageRowsRequestFilterModelLiableType1 |
            CoverageRowsRequestFilterModelLiableType2 | CoverageRowsRequestFilterModelLiableType3 |
            CoverageRowsRequestFilterModelLiableType4 | Unset):
        outcome (CoverageRowsRequestFilterModelOutcomeType0 | CoverageRowsRequestFilterModelOutcomeType1 |
            CoverageRowsRequestFilterModelOutcomeType2 | CoverageRowsRequestFilterModelOutcomeType3 |
            CoverageRowsRequestFilterModelOutcomeType4 | Unset):
        paid_by (CoverageRowsRequestFilterModelPaidByType0 | CoverageRowsRequestFilterModelPaidByType1 |
            CoverageRowsRequestFilterModelPaidByType2 | CoverageRowsRequestFilterModelPaidByType3 |
            CoverageRowsRequestFilterModelPaidByType4 | Unset):
        amber (CoverageRowsRequestFilterModelAmberType0 | CoverageRowsRequestFilterModelAmberType1 |
            CoverageRowsRequestFilterModelAmberType2 | CoverageRowsRequestFilterModelAmberType3 |
            CoverageRowsRequestFilterModelAmberType4 | Unset):
    """

    id: (
        CoverageRowsRequestFilterModelIdType0
        | CoverageRowsRequestFilterModelIdType1
        | CoverageRowsRequestFilterModelIdType2
        | CoverageRowsRequestFilterModelIdType3
        | CoverageRowsRequestFilterModelIdType4
        | Unset
    ) = UNSET
    created_at: (
        CoverageRowsRequestFilterModelCreatedAtType0
        | CoverageRowsRequestFilterModelCreatedAtType1
        | CoverageRowsRequestFilterModelCreatedAtType2
        | CoverageRowsRequestFilterModelCreatedAtType3
        | CoverageRowsRequestFilterModelCreatedAtType4
        | Unset
    ) = UNSET
    merchant_id: (
        CoverageRowsRequestFilterModelMerchantIdType0
        | CoverageRowsRequestFilterModelMerchantIdType1
        | CoverageRowsRequestFilterModelMerchantIdType2
        | CoverageRowsRequestFilterModelMerchantIdType3
        | CoverageRowsRequestFilterModelMerchantIdType4
        | Unset
    ) = UNSET
    amount: (
        CoverageRowsRequestFilterModelAmountType0
        | CoverageRowsRequestFilterModelAmountType1
        | CoverageRowsRequestFilterModelAmountType2
        | CoverageRowsRequestFilterModelAmountType3
        | CoverageRowsRequestFilterModelAmountType4
        | Unset
    ) = UNSET
    premium_bps: (
        CoverageRowsRequestFilterModelPremiumBpsType0
        | CoverageRowsRequestFilterModelPremiumBpsType1
        | CoverageRowsRequestFilterModelPremiumBpsType2
        | CoverageRowsRequestFilterModelPremiumBpsType3
        | CoverageRowsRequestFilterModelPremiumBpsType4
        | Unset
    ) = UNSET
    premium: (
        CoverageRowsRequestFilterModelPremiumType0
        | CoverageRowsRequestFilterModelPremiumType1
        | CoverageRowsRequestFilterModelPremiumType2
        | CoverageRowsRequestFilterModelPremiumType3
        | CoverageRowsRequestFilterModelPremiumType4
        | Unset
    ) = UNSET
    state: (
        CoverageRowsRequestFilterModelStateType0
        | CoverageRowsRequestFilterModelStateType1
        | CoverageRowsRequestFilterModelStateType2
        | CoverageRowsRequestFilterModelStateType3
        | CoverageRowsRequestFilterModelStateType4
        | Unset
    ) = UNSET
    dispute_state: (
        CoverageRowsRequestFilterModelDisputeStateType0
        | CoverageRowsRequestFilterModelDisputeStateType1
        | CoverageRowsRequestFilterModelDisputeStateType2
        | CoverageRowsRequestFilterModelDisputeStateType3
        | CoverageRowsRequestFilterModelDisputeStateType4
        | Unset
    ) = UNSET
    liable: (
        CoverageRowsRequestFilterModelLiableType0
        | CoverageRowsRequestFilterModelLiableType1
        | CoverageRowsRequestFilterModelLiableType2
        | CoverageRowsRequestFilterModelLiableType3
        | CoverageRowsRequestFilterModelLiableType4
        | Unset
    ) = UNSET
    outcome: (
        CoverageRowsRequestFilterModelOutcomeType0
        | CoverageRowsRequestFilterModelOutcomeType1
        | CoverageRowsRequestFilterModelOutcomeType2
        | CoverageRowsRequestFilterModelOutcomeType3
        | CoverageRowsRequestFilterModelOutcomeType4
        | Unset
    ) = UNSET
    paid_by: (
        CoverageRowsRequestFilterModelPaidByType0
        | CoverageRowsRequestFilterModelPaidByType1
        | CoverageRowsRequestFilterModelPaidByType2
        | CoverageRowsRequestFilterModelPaidByType3
        | CoverageRowsRequestFilterModelPaidByType4
        | Unset
    ) = UNSET
    amber: (
        CoverageRowsRequestFilterModelAmberType0
        | CoverageRowsRequestFilterModelAmberType1
        | CoverageRowsRequestFilterModelAmberType2
        | CoverageRowsRequestFilterModelAmberType3
        | CoverageRowsRequestFilterModelAmberType4
        | Unset
    ) = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.coverage_rows_request_filter_model_amber_type_0 import (
            CoverageRowsRequestFilterModelAmberType0,
        )
        from ..models.coverage_rows_request_filter_model_amber_type_1 import (
            CoverageRowsRequestFilterModelAmberType1,
        )
        from ..models.coverage_rows_request_filter_model_amber_type_2 import (
            CoverageRowsRequestFilterModelAmberType2,
        )
        from ..models.coverage_rows_request_filter_model_amber_type_3 import (
            CoverageRowsRequestFilterModelAmberType3,
        )
        from ..models.coverage_rows_request_filter_model_amount_type_0 import (
            CoverageRowsRequestFilterModelAmountType0,
        )
        from ..models.coverage_rows_request_filter_model_amount_type_1 import (
            CoverageRowsRequestFilterModelAmountType1,
        )
        from ..models.coverage_rows_request_filter_model_amount_type_2 import (
            CoverageRowsRequestFilterModelAmountType2,
        )
        from ..models.coverage_rows_request_filter_model_amount_type_3 import (
            CoverageRowsRequestFilterModelAmountType3,
        )
        from ..models.coverage_rows_request_filter_model_created_at_type_0 import (
            CoverageRowsRequestFilterModelCreatedAtType0,
        )
        from ..models.coverage_rows_request_filter_model_created_at_type_1 import (
            CoverageRowsRequestFilterModelCreatedAtType1,
        )
        from ..models.coverage_rows_request_filter_model_created_at_type_2 import (
            CoverageRowsRequestFilterModelCreatedAtType2,
        )
        from ..models.coverage_rows_request_filter_model_created_at_type_3 import (
            CoverageRowsRequestFilterModelCreatedAtType3,
        )
        from ..models.coverage_rows_request_filter_model_dispute_state_type_0 import (
            CoverageRowsRequestFilterModelDisputeStateType0,
        )
        from ..models.coverage_rows_request_filter_model_dispute_state_type_1 import (
            CoverageRowsRequestFilterModelDisputeStateType1,
        )
        from ..models.coverage_rows_request_filter_model_dispute_state_type_2 import (
            CoverageRowsRequestFilterModelDisputeStateType2,
        )
        from ..models.coverage_rows_request_filter_model_dispute_state_type_3 import (
            CoverageRowsRequestFilterModelDisputeStateType3,
        )
        from ..models.coverage_rows_request_filter_model_id_type_0 import (
            CoverageRowsRequestFilterModelIdType0,
        )
        from ..models.coverage_rows_request_filter_model_id_type_1 import (
            CoverageRowsRequestFilterModelIdType1,
        )
        from ..models.coverage_rows_request_filter_model_id_type_2 import (
            CoverageRowsRequestFilterModelIdType2,
        )
        from ..models.coverage_rows_request_filter_model_id_type_3 import (
            CoverageRowsRequestFilterModelIdType3,
        )
        from ..models.coverage_rows_request_filter_model_liable_type_0 import (
            CoverageRowsRequestFilterModelLiableType0,
        )
        from ..models.coverage_rows_request_filter_model_liable_type_1 import (
            CoverageRowsRequestFilterModelLiableType1,
        )
        from ..models.coverage_rows_request_filter_model_liable_type_2 import (
            CoverageRowsRequestFilterModelLiableType2,
        )
        from ..models.coverage_rows_request_filter_model_liable_type_3 import (
            CoverageRowsRequestFilterModelLiableType3,
        )
        from ..models.coverage_rows_request_filter_model_merchant_id_type_0 import (
            CoverageRowsRequestFilterModelMerchantIdType0,
        )
        from ..models.coverage_rows_request_filter_model_merchant_id_type_1 import (
            CoverageRowsRequestFilterModelMerchantIdType1,
        )
        from ..models.coverage_rows_request_filter_model_merchant_id_type_2 import (
            CoverageRowsRequestFilterModelMerchantIdType2,
        )
        from ..models.coverage_rows_request_filter_model_merchant_id_type_3 import (
            CoverageRowsRequestFilterModelMerchantIdType3,
        )
        from ..models.coverage_rows_request_filter_model_outcome_type_0 import (
            CoverageRowsRequestFilterModelOutcomeType0,
        )
        from ..models.coverage_rows_request_filter_model_outcome_type_1 import (
            CoverageRowsRequestFilterModelOutcomeType1,
        )
        from ..models.coverage_rows_request_filter_model_outcome_type_2 import (
            CoverageRowsRequestFilterModelOutcomeType2,
        )
        from ..models.coverage_rows_request_filter_model_outcome_type_3 import (
            CoverageRowsRequestFilterModelOutcomeType3,
        )
        from ..models.coverage_rows_request_filter_model_paid_by_type_0 import (
            CoverageRowsRequestFilterModelPaidByType0,
        )
        from ..models.coverage_rows_request_filter_model_paid_by_type_1 import (
            CoverageRowsRequestFilterModelPaidByType1,
        )
        from ..models.coverage_rows_request_filter_model_paid_by_type_2 import (
            CoverageRowsRequestFilterModelPaidByType2,
        )
        from ..models.coverage_rows_request_filter_model_paid_by_type_3 import (
            CoverageRowsRequestFilterModelPaidByType3,
        )
        from ..models.coverage_rows_request_filter_model_premium_bps_type_0 import (
            CoverageRowsRequestFilterModelPremiumBpsType0,
        )
        from ..models.coverage_rows_request_filter_model_premium_bps_type_1 import (
            CoverageRowsRequestFilterModelPremiumBpsType1,
        )
        from ..models.coverage_rows_request_filter_model_premium_bps_type_2 import (
            CoverageRowsRequestFilterModelPremiumBpsType2,
        )
        from ..models.coverage_rows_request_filter_model_premium_bps_type_3 import (
            CoverageRowsRequestFilterModelPremiumBpsType3,
        )
        from ..models.coverage_rows_request_filter_model_premium_type_0 import (
            CoverageRowsRequestFilterModelPremiumType0,
        )
        from ..models.coverage_rows_request_filter_model_premium_type_1 import (
            CoverageRowsRequestFilterModelPremiumType1,
        )
        from ..models.coverage_rows_request_filter_model_premium_type_2 import (
            CoverageRowsRequestFilterModelPremiumType2,
        )
        from ..models.coverage_rows_request_filter_model_premium_type_3 import (
            CoverageRowsRequestFilterModelPremiumType3,
        )
        from ..models.coverage_rows_request_filter_model_state_type_0 import (
            CoverageRowsRequestFilterModelStateType0,
        )
        from ..models.coverage_rows_request_filter_model_state_type_1 import (
            CoverageRowsRequestFilterModelStateType1,
        )
        from ..models.coverage_rows_request_filter_model_state_type_2 import (
            CoverageRowsRequestFilterModelStateType2,
        )
        from ..models.coverage_rows_request_filter_model_state_type_3 import (
            CoverageRowsRequestFilterModelStateType3,
        )

        id: dict[str, Any] | Unset
        if isinstance(self.id, Unset):
            id = UNSET
        elif (
            isinstance(self.id, CoverageRowsRequestFilterModelIdType0)
            or isinstance(self.id, CoverageRowsRequestFilterModelIdType1)
            or isinstance(self.id, CoverageRowsRequestFilterModelIdType2)
            or isinstance(self.id, CoverageRowsRequestFilterModelIdType3)
        ):
            id = self.id.to_dict()
        else:
            id = self.id.to_dict()

        created_at: dict[str, Any] | Unset
        if isinstance(self.created_at, Unset):
            created_at = UNSET
        elif (
            isinstance(self.created_at, CoverageRowsRequestFilterModelCreatedAtType0)
            or isinstance(self.created_at, CoverageRowsRequestFilterModelCreatedAtType1)
            or isinstance(self.created_at, CoverageRowsRequestFilterModelCreatedAtType2)
            or isinstance(self.created_at, CoverageRowsRequestFilterModelCreatedAtType3)
        ):
            created_at = self.created_at.to_dict()
        else:
            created_at = self.created_at.to_dict()

        merchant_id: dict[str, Any] | Unset
        if isinstance(self.merchant_id, Unset):
            merchant_id = UNSET
        elif (
            isinstance(self.merchant_id, CoverageRowsRequestFilterModelMerchantIdType0)
            or isinstance(self.merchant_id, CoverageRowsRequestFilterModelMerchantIdType1)
            or isinstance(self.merchant_id, CoverageRowsRequestFilterModelMerchantIdType2)
            or isinstance(self.merchant_id, CoverageRowsRequestFilterModelMerchantIdType3)
        ):
            merchant_id = self.merchant_id.to_dict()
        else:
            merchant_id = self.merchant_id.to_dict()

        amount: dict[str, Any] | Unset
        if isinstance(self.amount, Unset):
            amount = UNSET
        elif (
            isinstance(self.amount, CoverageRowsRequestFilterModelAmountType0)
            or isinstance(self.amount, CoverageRowsRequestFilterModelAmountType1)
            or isinstance(self.amount, CoverageRowsRequestFilterModelAmountType2)
            or isinstance(self.amount, CoverageRowsRequestFilterModelAmountType3)
        ):
            amount = self.amount.to_dict()
        else:
            amount = self.amount.to_dict()

        premium_bps: dict[str, Any] | Unset
        if isinstance(self.premium_bps, Unset):
            premium_bps = UNSET
        elif (
            isinstance(self.premium_bps, CoverageRowsRequestFilterModelPremiumBpsType0)
            or isinstance(self.premium_bps, CoverageRowsRequestFilterModelPremiumBpsType1)
            or isinstance(self.premium_bps, CoverageRowsRequestFilterModelPremiumBpsType2)
            or isinstance(self.premium_bps, CoverageRowsRequestFilterModelPremiumBpsType3)
        ):
            premium_bps = self.premium_bps.to_dict()
        else:
            premium_bps = self.premium_bps.to_dict()

        premium: dict[str, Any] | Unset
        if isinstance(self.premium, Unset):
            premium = UNSET
        elif (
            isinstance(self.premium, CoverageRowsRequestFilterModelPremiumType0)
            or isinstance(self.premium, CoverageRowsRequestFilterModelPremiumType1)
            or isinstance(self.premium, CoverageRowsRequestFilterModelPremiumType2)
            or isinstance(self.premium, CoverageRowsRequestFilterModelPremiumType3)
        ):
            premium = self.premium.to_dict()
        else:
            premium = self.premium.to_dict()

        state: dict[str, Any] | Unset
        if isinstance(self.state, Unset):
            state = UNSET
        elif (
            isinstance(self.state, CoverageRowsRequestFilterModelStateType0)
            or isinstance(self.state, CoverageRowsRequestFilterModelStateType1)
            or isinstance(self.state, CoverageRowsRequestFilterModelStateType2)
            or isinstance(self.state, CoverageRowsRequestFilterModelStateType3)
        ):
            state = self.state.to_dict()
        else:
            state = self.state.to_dict()

        dispute_state: dict[str, Any] | Unset
        if isinstance(self.dispute_state, Unset):
            dispute_state = UNSET
        elif (
            isinstance(self.dispute_state, CoverageRowsRequestFilterModelDisputeStateType0)
            or isinstance(self.dispute_state, CoverageRowsRequestFilterModelDisputeStateType1)
            or isinstance(self.dispute_state, CoverageRowsRequestFilterModelDisputeStateType2)
            or isinstance(self.dispute_state, CoverageRowsRequestFilterModelDisputeStateType3)
        ):
            dispute_state = self.dispute_state.to_dict()
        else:
            dispute_state = self.dispute_state.to_dict()

        liable: dict[str, Any] | Unset
        if isinstance(self.liable, Unset):
            liable = UNSET
        elif (
            isinstance(self.liable, CoverageRowsRequestFilterModelLiableType0)
            or isinstance(self.liable, CoverageRowsRequestFilterModelLiableType1)
            or isinstance(self.liable, CoverageRowsRequestFilterModelLiableType2)
            or isinstance(self.liable, CoverageRowsRequestFilterModelLiableType3)
        ):
            liable = self.liable.to_dict()
        else:
            liable = self.liable.to_dict()

        outcome: dict[str, Any] | Unset
        if isinstance(self.outcome, Unset):
            outcome = UNSET
        elif (
            isinstance(self.outcome, CoverageRowsRequestFilterModelOutcomeType0)
            or isinstance(self.outcome, CoverageRowsRequestFilterModelOutcomeType1)
            or isinstance(self.outcome, CoverageRowsRequestFilterModelOutcomeType2)
            or isinstance(self.outcome, CoverageRowsRequestFilterModelOutcomeType3)
        ):
            outcome = self.outcome.to_dict()
        else:
            outcome = self.outcome.to_dict()

        paid_by: dict[str, Any] | Unset
        if isinstance(self.paid_by, Unset):
            paid_by = UNSET
        elif (
            isinstance(self.paid_by, CoverageRowsRequestFilterModelPaidByType0)
            or isinstance(self.paid_by, CoverageRowsRequestFilterModelPaidByType1)
            or isinstance(self.paid_by, CoverageRowsRequestFilterModelPaidByType2)
            or isinstance(self.paid_by, CoverageRowsRequestFilterModelPaidByType3)
        ):
            paid_by = self.paid_by.to_dict()
        else:
            paid_by = self.paid_by.to_dict()

        amber: dict[str, Any] | Unset
        if isinstance(self.amber, Unset):
            amber = UNSET
        elif (
            isinstance(self.amber, CoverageRowsRequestFilterModelAmberType0)
            or isinstance(self.amber, CoverageRowsRequestFilterModelAmberType1)
            or isinstance(self.amber, CoverageRowsRequestFilterModelAmberType2)
            or isinstance(self.amber, CoverageRowsRequestFilterModelAmberType3)
        ):
            amber = self.amber.to_dict()
        else:
            amber = self.amber.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if id is not UNSET:
            field_dict["id"] = id
        if created_at is not UNSET:
            field_dict["createdAt"] = created_at
        if merchant_id is not UNSET:
            field_dict["merchantId"] = merchant_id
        if amount is not UNSET:
            field_dict["amount"] = amount
        if premium_bps is not UNSET:
            field_dict["premiumBps"] = premium_bps
        if premium is not UNSET:
            field_dict["premium"] = premium
        if state is not UNSET:
            field_dict["state"] = state
        if dispute_state is not UNSET:
            field_dict["disputeState"] = dispute_state
        if liable is not UNSET:
            field_dict["liable"] = liable
        if outcome is not UNSET:
            field_dict["outcome"] = outcome
        if paid_by is not UNSET:
            field_dict["paidBy"] = paid_by
        if amber is not UNSET:
            field_dict["amber"] = amber

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.coverage_rows_request_filter_model_amber_type_0 import (
            CoverageRowsRequestFilterModelAmberType0,
        )
        from ..models.coverage_rows_request_filter_model_amber_type_1 import (
            CoverageRowsRequestFilterModelAmberType1,
        )
        from ..models.coverage_rows_request_filter_model_amber_type_2 import (
            CoverageRowsRequestFilterModelAmberType2,
        )
        from ..models.coverage_rows_request_filter_model_amber_type_3 import (
            CoverageRowsRequestFilterModelAmberType3,
        )
        from ..models.coverage_rows_request_filter_model_amber_type_4 import (
            CoverageRowsRequestFilterModelAmberType4,
        )
        from ..models.coverage_rows_request_filter_model_amount_type_0 import (
            CoverageRowsRequestFilterModelAmountType0,
        )
        from ..models.coverage_rows_request_filter_model_amount_type_1 import (
            CoverageRowsRequestFilterModelAmountType1,
        )
        from ..models.coverage_rows_request_filter_model_amount_type_2 import (
            CoverageRowsRequestFilterModelAmountType2,
        )
        from ..models.coverage_rows_request_filter_model_amount_type_3 import (
            CoverageRowsRequestFilterModelAmountType3,
        )
        from ..models.coverage_rows_request_filter_model_amount_type_4 import (
            CoverageRowsRequestFilterModelAmountType4,
        )
        from ..models.coverage_rows_request_filter_model_created_at_type_0 import (
            CoverageRowsRequestFilterModelCreatedAtType0,
        )
        from ..models.coverage_rows_request_filter_model_created_at_type_1 import (
            CoverageRowsRequestFilterModelCreatedAtType1,
        )
        from ..models.coverage_rows_request_filter_model_created_at_type_2 import (
            CoverageRowsRequestFilterModelCreatedAtType2,
        )
        from ..models.coverage_rows_request_filter_model_created_at_type_3 import (
            CoverageRowsRequestFilterModelCreatedAtType3,
        )
        from ..models.coverage_rows_request_filter_model_created_at_type_4 import (
            CoverageRowsRequestFilterModelCreatedAtType4,
        )
        from ..models.coverage_rows_request_filter_model_dispute_state_type_0 import (
            CoverageRowsRequestFilterModelDisputeStateType0,
        )
        from ..models.coverage_rows_request_filter_model_dispute_state_type_1 import (
            CoverageRowsRequestFilterModelDisputeStateType1,
        )
        from ..models.coverage_rows_request_filter_model_dispute_state_type_2 import (
            CoverageRowsRequestFilterModelDisputeStateType2,
        )
        from ..models.coverage_rows_request_filter_model_dispute_state_type_3 import (
            CoverageRowsRequestFilterModelDisputeStateType3,
        )
        from ..models.coverage_rows_request_filter_model_dispute_state_type_4 import (
            CoverageRowsRequestFilterModelDisputeStateType4,
        )
        from ..models.coverage_rows_request_filter_model_id_type_0 import (
            CoverageRowsRequestFilterModelIdType0,
        )
        from ..models.coverage_rows_request_filter_model_id_type_1 import (
            CoverageRowsRequestFilterModelIdType1,
        )
        from ..models.coverage_rows_request_filter_model_id_type_2 import (
            CoverageRowsRequestFilterModelIdType2,
        )
        from ..models.coverage_rows_request_filter_model_id_type_3 import (
            CoverageRowsRequestFilterModelIdType3,
        )
        from ..models.coverage_rows_request_filter_model_id_type_4 import (
            CoverageRowsRequestFilterModelIdType4,
        )
        from ..models.coverage_rows_request_filter_model_liable_type_0 import (
            CoverageRowsRequestFilterModelLiableType0,
        )
        from ..models.coverage_rows_request_filter_model_liable_type_1 import (
            CoverageRowsRequestFilterModelLiableType1,
        )
        from ..models.coverage_rows_request_filter_model_liable_type_2 import (
            CoverageRowsRequestFilterModelLiableType2,
        )
        from ..models.coverage_rows_request_filter_model_liable_type_3 import (
            CoverageRowsRequestFilterModelLiableType3,
        )
        from ..models.coverage_rows_request_filter_model_liable_type_4 import (
            CoverageRowsRequestFilterModelLiableType4,
        )
        from ..models.coverage_rows_request_filter_model_merchant_id_type_0 import (
            CoverageRowsRequestFilterModelMerchantIdType0,
        )
        from ..models.coverage_rows_request_filter_model_merchant_id_type_1 import (
            CoverageRowsRequestFilterModelMerchantIdType1,
        )
        from ..models.coverage_rows_request_filter_model_merchant_id_type_2 import (
            CoverageRowsRequestFilterModelMerchantIdType2,
        )
        from ..models.coverage_rows_request_filter_model_merchant_id_type_3 import (
            CoverageRowsRequestFilterModelMerchantIdType3,
        )
        from ..models.coverage_rows_request_filter_model_merchant_id_type_4 import (
            CoverageRowsRequestFilterModelMerchantIdType4,
        )
        from ..models.coverage_rows_request_filter_model_outcome_type_0 import (
            CoverageRowsRequestFilterModelOutcomeType0,
        )
        from ..models.coverage_rows_request_filter_model_outcome_type_1 import (
            CoverageRowsRequestFilterModelOutcomeType1,
        )
        from ..models.coverage_rows_request_filter_model_outcome_type_2 import (
            CoverageRowsRequestFilterModelOutcomeType2,
        )
        from ..models.coverage_rows_request_filter_model_outcome_type_3 import (
            CoverageRowsRequestFilterModelOutcomeType3,
        )
        from ..models.coverage_rows_request_filter_model_outcome_type_4 import (
            CoverageRowsRequestFilterModelOutcomeType4,
        )
        from ..models.coverage_rows_request_filter_model_paid_by_type_0 import (
            CoverageRowsRequestFilterModelPaidByType0,
        )
        from ..models.coverage_rows_request_filter_model_paid_by_type_1 import (
            CoverageRowsRequestFilterModelPaidByType1,
        )
        from ..models.coverage_rows_request_filter_model_paid_by_type_2 import (
            CoverageRowsRequestFilterModelPaidByType2,
        )
        from ..models.coverage_rows_request_filter_model_paid_by_type_3 import (
            CoverageRowsRequestFilterModelPaidByType3,
        )
        from ..models.coverage_rows_request_filter_model_paid_by_type_4 import (
            CoverageRowsRequestFilterModelPaidByType4,
        )
        from ..models.coverage_rows_request_filter_model_premium_bps_type_0 import (
            CoverageRowsRequestFilterModelPremiumBpsType0,
        )
        from ..models.coverage_rows_request_filter_model_premium_bps_type_1 import (
            CoverageRowsRequestFilterModelPremiumBpsType1,
        )
        from ..models.coverage_rows_request_filter_model_premium_bps_type_2 import (
            CoverageRowsRequestFilterModelPremiumBpsType2,
        )
        from ..models.coverage_rows_request_filter_model_premium_bps_type_3 import (
            CoverageRowsRequestFilterModelPremiumBpsType3,
        )
        from ..models.coverage_rows_request_filter_model_premium_bps_type_4 import (
            CoverageRowsRequestFilterModelPremiumBpsType4,
        )
        from ..models.coverage_rows_request_filter_model_premium_type_0 import (
            CoverageRowsRequestFilterModelPremiumType0,
        )
        from ..models.coverage_rows_request_filter_model_premium_type_1 import (
            CoverageRowsRequestFilterModelPremiumType1,
        )
        from ..models.coverage_rows_request_filter_model_premium_type_2 import (
            CoverageRowsRequestFilterModelPremiumType2,
        )
        from ..models.coverage_rows_request_filter_model_premium_type_3 import (
            CoverageRowsRequestFilterModelPremiumType3,
        )
        from ..models.coverage_rows_request_filter_model_premium_type_4 import (
            CoverageRowsRequestFilterModelPremiumType4,
        )
        from ..models.coverage_rows_request_filter_model_state_type_0 import (
            CoverageRowsRequestFilterModelStateType0,
        )
        from ..models.coverage_rows_request_filter_model_state_type_1 import (
            CoverageRowsRequestFilterModelStateType1,
        )
        from ..models.coverage_rows_request_filter_model_state_type_2 import (
            CoverageRowsRequestFilterModelStateType2,
        )
        from ..models.coverage_rows_request_filter_model_state_type_3 import (
            CoverageRowsRequestFilterModelStateType3,
        )
        from ..models.coverage_rows_request_filter_model_state_type_4 import (
            CoverageRowsRequestFilterModelStateType4,
        )

        d = dict(src_dict)

        def _parse_id(
            data: object,
        ) -> (
            CoverageRowsRequestFilterModelIdType0
            | CoverageRowsRequestFilterModelIdType1
            | CoverageRowsRequestFilterModelIdType2
            | CoverageRowsRequestFilterModelIdType3
            | CoverageRowsRequestFilterModelIdType4
            | Unset
        ):
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                id_type_0 = CoverageRowsRequestFilterModelIdType0.from_dict(data)

                return id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                id_type_1 = CoverageRowsRequestFilterModelIdType1.from_dict(data)

                return id_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                id_type_2 = CoverageRowsRequestFilterModelIdType2.from_dict(data)

                return id_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                id_type_3 = CoverageRowsRequestFilterModelIdType3.from_dict(data)

                return id_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            id_type_4 = CoverageRowsRequestFilterModelIdType4.from_dict(data)

            return id_type_4

        id = _parse_id(d.pop("id", UNSET))

        def _parse_created_at(
            data: object,
        ) -> (
            CoverageRowsRequestFilterModelCreatedAtType0
            | CoverageRowsRequestFilterModelCreatedAtType1
            | CoverageRowsRequestFilterModelCreatedAtType2
            | CoverageRowsRequestFilterModelCreatedAtType3
            | CoverageRowsRequestFilterModelCreatedAtType4
            | Unset
        ):
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                created_at_type_0 = CoverageRowsRequestFilterModelCreatedAtType0.from_dict(data)

                return created_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                created_at_type_1 = CoverageRowsRequestFilterModelCreatedAtType1.from_dict(data)

                return created_at_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                created_at_type_2 = CoverageRowsRequestFilterModelCreatedAtType2.from_dict(data)

                return created_at_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                created_at_type_3 = CoverageRowsRequestFilterModelCreatedAtType3.from_dict(data)

                return created_at_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            created_at_type_4 = CoverageRowsRequestFilterModelCreatedAtType4.from_dict(data)

            return created_at_type_4

        created_at = _parse_created_at(d.pop("createdAt", UNSET))

        def _parse_merchant_id(
            data: object,
        ) -> (
            CoverageRowsRequestFilterModelMerchantIdType0
            | CoverageRowsRequestFilterModelMerchantIdType1
            | CoverageRowsRequestFilterModelMerchantIdType2
            | CoverageRowsRequestFilterModelMerchantIdType3
            | CoverageRowsRequestFilterModelMerchantIdType4
            | Unset
        ):
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                merchant_id_type_0 = CoverageRowsRequestFilterModelMerchantIdType0.from_dict(data)

                return merchant_id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                merchant_id_type_1 = CoverageRowsRequestFilterModelMerchantIdType1.from_dict(data)

                return merchant_id_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                merchant_id_type_2 = CoverageRowsRequestFilterModelMerchantIdType2.from_dict(data)

                return merchant_id_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                merchant_id_type_3 = CoverageRowsRequestFilterModelMerchantIdType3.from_dict(data)

                return merchant_id_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            merchant_id_type_4 = CoverageRowsRequestFilterModelMerchantIdType4.from_dict(data)

            return merchant_id_type_4

        merchant_id = _parse_merchant_id(d.pop("merchantId", UNSET))

        def _parse_amount(
            data: object,
        ) -> (
            CoverageRowsRequestFilterModelAmountType0
            | CoverageRowsRequestFilterModelAmountType1
            | CoverageRowsRequestFilterModelAmountType2
            | CoverageRowsRequestFilterModelAmountType3
            | CoverageRowsRequestFilterModelAmountType4
            | Unset
        ):
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                amount_type_0 = CoverageRowsRequestFilterModelAmountType0.from_dict(data)

                return amount_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                amount_type_1 = CoverageRowsRequestFilterModelAmountType1.from_dict(data)

                return amount_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                amount_type_2 = CoverageRowsRequestFilterModelAmountType2.from_dict(data)

                return amount_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                amount_type_3 = CoverageRowsRequestFilterModelAmountType3.from_dict(data)

                return amount_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            amount_type_4 = CoverageRowsRequestFilterModelAmountType4.from_dict(data)

            return amount_type_4

        amount = _parse_amount(d.pop("amount", UNSET))

        def _parse_premium_bps(
            data: object,
        ) -> (
            CoverageRowsRequestFilterModelPremiumBpsType0
            | CoverageRowsRequestFilterModelPremiumBpsType1
            | CoverageRowsRequestFilterModelPremiumBpsType2
            | CoverageRowsRequestFilterModelPremiumBpsType3
            | CoverageRowsRequestFilterModelPremiumBpsType4
            | Unset
        ):
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                premium_bps_type_0 = CoverageRowsRequestFilterModelPremiumBpsType0.from_dict(data)

                return premium_bps_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                premium_bps_type_1 = CoverageRowsRequestFilterModelPremiumBpsType1.from_dict(data)

                return premium_bps_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                premium_bps_type_2 = CoverageRowsRequestFilterModelPremiumBpsType2.from_dict(data)

                return premium_bps_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                premium_bps_type_3 = CoverageRowsRequestFilterModelPremiumBpsType3.from_dict(data)

                return premium_bps_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            premium_bps_type_4 = CoverageRowsRequestFilterModelPremiumBpsType4.from_dict(data)

            return premium_bps_type_4

        premium_bps = _parse_premium_bps(d.pop("premiumBps", UNSET))

        def _parse_premium(
            data: object,
        ) -> (
            CoverageRowsRequestFilterModelPremiumType0
            | CoverageRowsRequestFilterModelPremiumType1
            | CoverageRowsRequestFilterModelPremiumType2
            | CoverageRowsRequestFilterModelPremiumType3
            | CoverageRowsRequestFilterModelPremiumType4
            | Unset
        ):
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                premium_type_0 = CoverageRowsRequestFilterModelPremiumType0.from_dict(data)

                return premium_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                premium_type_1 = CoverageRowsRequestFilterModelPremiumType1.from_dict(data)

                return premium_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                premium_type_2 = CoverageRowsRequestFilterModelPremiumType2.from_dict(data)

                return premium_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                premium_type_3 = CoverageRowsRequestFilterModelPremiumType3.from_dict(data)

                return premium_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            premium_type_4 = CoverageRowsRequestFilterModelPremiumType4.from_dict(data)

            return premium_type_4

        premium = _parse_premium(d.pop("premium", UNSET))

        def _parse_state(
            data: object,
        ) -> (
            CoverageRowsRequestFilterModelStateType0
            | CoverageRowsRequestFilterModelStateType1
            | CoverageRowsRequestFilterModelStateType2
            | CoverageRowsRequestFilterModelStateType3
            | CoverageRowsRequestFilterModelStateType4
            | Unset
        ):
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                state_type_0 = CoverageRowsRequestFilterModelStateType0.from_dict(data)

                return state_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                state_type_1 = CoverageRowsRequestFilterModelStateType1.from_dict(data)

                return state_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                state_type_2 = CoverageRowsRequestFilterModelStateType2.from_dict(data)

                return state_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                state_type_3 = CoverageRowsRequestFilterModelStateType3.from_dict(data)

                return state_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            state_type_4 = CoverageRowsRequestFilterModelStateType4.from_dict(data)

            return state_type_4

        state = _parse_state(d.pop("state", UNSET))

        def _parse_dispute_state(
            data: object,
        ) -> (
            CoverageRowsRequestFilterModelDisputeStateType0
            | CoverageRowsRequestFilterModelDisputeStateType1
            | CoverageRowsRequestFilterModelDisputeStateType2
            | CoverageRowsRequestFilterModelDisputeStateType3
            | CoverageRowsRequestFilterModelDisputeStateType4
            | Unset
        ):
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                dispute_state_type_0 = CoverageRowsRequestFilterModelDisputeStateType0.from_dict(
                    data
                )

                return dispute_state_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                dispute_state_type_1 = CoverageRowsRequestFilterModelDisputeStateType1.from_dict(
                    data
                )

                return dispute_state_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                dispute_state_type_2 = CoverageRowsRequestFilterModelDisputeStateType2.from_dict(
                    data
                )

                return dispute_state_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                dispute_state_type_3 = CoverageRowsRequestFilterModelDisputeStateType3.from_dict(
                    data
                )

                return dispute_state_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            dispute_state_type_4 = CoverageRowsRequestFilterModelDisputeStateType4.from_dict(data)

            return dispute_state_type_4

        dispute_state = _parse_dispute_state(d.pop("disputeState", UNSET))

        def _parse_liable(
            data: object,
        ) -> (
            CoverageRowsRequestFilterModelLiableType0
            | CoverageRowsRequestFilterModelLiableType1
            | CoverageRowsRequestFilterModelLiableType2
            | CoverageRowsRequestFilterModelLiableType3
            | CoverageRowsRequestFilterModelLiableType4
            | Unset
        ):
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                liable_type_0 = CoverageRowsRequestFilterModelLiableType0.from_dict(data)

                return liable_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                liable_type_1 = CoverageRowsRequestFilterModelLiableType1.from_dict(data)

                return liable_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                liable_type_2 = CoverageRowsRequestFilterModelLiableType2.from_dict(data)

                return liable_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                liable_type_3 = CoverageRowsRequestFilterModelLiableType3.from_dict(data)

                return liable_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            liable_type_4 = CoverageRowsRequestFilterModelLiableType4.from_dict(data)

            return liable_type_4

        liable = _parse_liable(d.pop("liable", UNSET))

        def _parse_outcome(
            data: object,
        ) -> (
            CoverageRowsRequestFilterModelOutcomeType0
            | CoverageRowsRequestFilterModelOutcomeType1
            | CoverageRowsRequestFilterModelOutcomeType2
            | CoverageRowsRequestFilterModelOutcomeType3
            | CoverageRowsRequestFilterModelOutcomeType4
            | Unset
        ):
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                outcome_type_0 = CoverageRowsRequestFilterModelOutcomeType0.from_dict(data)

                return outcome_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                outcome_type_1 = CoverageRowsRequestFilterModelOutcomeType1.from_dict(data)

                return outcome_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                outcome_type_2 = CoverageRowsRequestFilterModelOutcomeType2.from_dict(data)

                return outcome_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                outcome_type_3 = CoverageRowsRequestFilterModelOutcomeType3.from_dict(data)

                return outcome_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            outcome_type_4 = CoverageRowsRequestFilterModelOutcomeType4.from_dict(data)

            return outcome_type_4

        outcome = _parse_outcome(d.pop("outcome", UNSET))

        def _parse_paid_by(
            data: object,
        ) -> (
            CoverageRowsRequestFilterModelPaidByType0
            | CoverageRowsRequestFilterModelPaidByType1
            | CoverageRowsRequestFilterModelPaidByType2
            | CoverageRowsRequestFilterModelPaidByType3
            | CoverageRowsRequestFilterModelPaidByType4
            | Unset
        ):
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                paid_by_type_0 = CoverageRowsRequestFilterModelPaidByType0.from_dict(data)

                return paid_by_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                paid_by_type_1 = CoverageRowsRequestFilterModelPaidByType1.from_dict(data)

                return paid_by_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                paid_by_type_2 = CoverageRowsRequestFilterModelPaidByType2.from_dict(data)

                return paid_by_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                paid_by_type_3 = CoverageRowsRequestFilterModelPaidByType3.from_dict(data)

                return paid_by_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            paid_by_type_4 = CoverageRowsRequestFilterModelPaidByType4.from_dict(data)

            return paid_by_type_4

        paid_by = _parse_paid_by(d.pop("paidBy", UNSET))

        def _parse_amber(
            data: object,
        ) -> (
            CoverageRowsRequestFilterModelAmberType0
            | CoverageRowsRequestFilterModelAmberType1
            | CoverageRowsRequestFilterModelAmberType2
            | CoverageRowsRequestFilterModelAmberType3
            | CoverageRowsRequestFilterModelAmberType4
            | Unset
        ):
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                amber_type_0 = CoverageRowsRequestFilterModelAmberType0.from_dict(data)

                return amber_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                amber_type_1 = CoverageRowsRequestFilterModelAmberType1.from_dict(data)

                return amber_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                amber_type_2 = CoverageRowsRequestFilterModelAmberType2.from_dict(data)

                return amber_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                amber_type_3 = CoverageRowsRequestFilterModelAmberType3.from_dict(data)

                return amber_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            amber_type_4 = CoverageRowsRequestFilterModelAmberType4.from_dict(data)

            return amber_type_4

        amber = _parse_amber(d.pop("amber", UNSET))

        coverage_rows_request_filter_model = cls(
            id=id,
            created_at=created_at,
            merchant_id=merchant_id,
            amount=amount,
            premium_bps=premium_bps,
            premium=premium,
            state=state,
            dispute_state=dispute_state,
            liable=liable,
            outcome=outcome,
            paid_by=paid_by,
            amber=amber,
        )

        coverage_rows_request_filter_model.additional_properties = d
        return coverage_rows_request_filter_model

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
