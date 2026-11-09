use alloy_primitives::{Address, B256, U256, address, b256};
use alloy_sol_types::SolStruct;
use keelson_core::{Dst, domain, hash_object};
use keelson_policy::{
    Attribution, Facts, Liable, NO_FIELD, Reason, VerdictError, VerdictInput, attribute,
    attribution_policy_set_hash, dispute_id, inputs_hash, verdict,
};

/// The `VerdictVerifier` on Arbitrum Sepolia, whose `hashTypedData` gave the golden digest.
const VERDICT_VERIFIER: Address = address!("e16E8767EC1DA59Ef0D9Bc7851637E4D22352d96");
const COVERAGE: B256 = b256!("1111111111111111111111111111111111111111111111111111111111111111");

fn amber_failure() -> Facts {
    Facts {
        reason: Reason::Unauthorised,
        proof_valid: true,
        failed_green: false,
        failed_amber: true,
        failed_gray: false,
        captured_eq_countersigned: true,
        duplicate_countersig: false,
        duplicate_capture: false,
        tracking_delivered: false,
        snapshot_matches_item: true,
        refund_recorded: false,
    }
}

fn input(field_id: u8) -> VerdictInput<'static> {
    VerdictInput {
        paypal_dispute_id: "PP-D-27803",
        coverage_id: COVERAGE,
        agent_id: U256::from(42),
        payee: address!("2222222222222222222222222222222222222222"),
        amount: 125_000_000,
        field_id,
        evidence_hash: b256!("3333333333333333333333333333333333333333333333333333333333333333"),
        checkpoint_root: b256!("6666666666666666666666666666666666666666666666666666666666666666"),
        issued_at: 1_794_240_000,
        deadline: 1_794_844_800,
    }
}

#[test]
fn dispute_id_is_keccak_of_the_packed_ids() {
    // cast keccak $(cast concat-hex $(cast from-utf8 PP-D-27803) 0x1111…11)
    assert_eq!(
        dispute_id("PP-D-27803", COVERAGE),
        b256!("bd2aecbac7e76885ce28a2805012a05e5963e0edb5fac50ebd6122d046bbe8ed")
    );
}

#[test]
fn verdict_digest_matches_the_deployed_verifier() {
    let facts = amber_failure();
    let attribution = attribute(&facts).unwrap();
    assert_eq!(
        attribution,
        Attribution {
            rule: 61,
            liable: Liable::Operator
        }
    );
    let mut v = verdict(&facts, &input(9)).unwrap();
    assert_eq!(v.ruleId, 61);
    assert_eq!(v.liable, 1);
    assert_eq!(v.fieldId, 9);
    assert_eq!(v.inputsHash, inputs_hash(&facts));
    assert_eq!(v.policySetHash, B256::from(attribution_policy_set_hash()));
    assert_eq!(
        v.inputsHash,
        B256::from(hash_object(Dst::Verdict, &serde_json::to_value(&facts).unwrap()).unwrap())
    );

    // The golden digest fixes these two to constants: VerdictVerifier.hashTypedData(structHash)
    // on Arbitrum Sepolia, with the struct hash from `cast abi-encode` and `cast keccak`.
    v.inputsHash = b256!("4444444444444444444444444444444444444444444444444444444444444444");
    v.policySetHash = b256!("5555555555555555555555555555555555555555555555555555555555555555");
    assert_eq!(
        v.eip712_hash_struct(),
        b256!("91f3c9045a3c1f04089a28dda4ded32e10139e00d522f13dd5170db29db45dc7")
    );
    let domain = domain(421_614, VERDICT_VERIFIER).unwrap();
    assert_eq!(
        v.eip712_signing_hash(&domain),
        b256!("a6c838c48ea6544db41379c0d10043f4011ddb2a917ef8e8008309d0f2262f30")
    );
}

#[test]
fn liable_codes_are_the_contracts() {
    let vault = include_str!("../../../contracts/src/KeelsonBondVault.sol");
    let reserve = include_str!("../../../contracts/src/KeelsonReserve.sol");
    assert!(vault.contains(&format!(
        "uint8 internal constant LIABLE_OPERATOR = {};",
        Liable::Operator as u8
    )));
    assert!(reserve.contains(&format!(
        "uint8 internal constant LIABLE_KEELSON = {};",
        Liable::Keelson as u8
    )));
}

#[test]
fn field_rules_need_a_field_and_others_take_none() {
    let facts = amber_failure();
    assert_eq!(
        verdict(&facts, &input(NO_FIELD)).err(),
        Some(VerdictError::FieldRequired(61))
    );
    let clean = Facts {
        failed_amber: false,
        ..amber_failure()
    };
    assert_eq!(attribute(&clean).unwrap().rule, 70);
    assert_eq!(
        verdict(&clean, &input(9)).err(),
        Some(VerdictError::FieldNotApplicable(70))
    );
    assert_eq!(verdict(&clean, &input(NO_FIELD)).unwrap().fieldId, NO_FIELD);
}

#[test]
fn out_of_range_inputs_are_rejected() {
    let facts = amber_failure();
    let too_much = VerdictInput {
        amount: 1 << 96,
        ..input(9)
    };
    assert_eq!(
        verdict(&facts, &too_much).err(),
        Some(VerdictError::AmountTooLarge)
    );
    let late = VerdictInput {
        deadline: 1 << 40,
        ..input(9)
    };
    assert_eq!(
        verdict(&facts, &late).err(),
        Some(VerdictError::TimeTooLarge)
    );
    let expired = VerdictInput {
        deadline: 1_794_240_000,
        ..input(9)
    };
    assert_eq!(
        verdict(&facts, &expired).err(),
        Some(VerdictError::DeadlineNotAfterIssue)
    );
    let anonymous = VerdictInput {
        paypal_dispute_id: "",
        ..input(9)
    };
    assert_eq!(
        verdict(&facts, &anonymous).err(),
        Some(VerdictError::EmptyDisputeId)
    );
}
