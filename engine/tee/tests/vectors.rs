use alloy_primitives::{Address, B256, Signature, U256, keccak256};
use keelson_core::{domain, eip712::Countersign};
use keelson_tee::{
    BIT_CANON, BIT_CEDAR_ERROR, BIT_PAYPAL, FIELD_BITS, Signer, SignerBinding, TeeKind,
    countersign_digest, failed_fields_mask, report_data,
};
use serde_json::Value;

fn load(json: &str) -> Vec<Value> {
    serde_json::from_str(json).expect("vectors file is valid")
}

fn b32(v: &Value) -> B256 {
    v.as_str().unwrap().parse().unwrap()
}

fn uint(v: &Value) -> U256 {
    U256::from_str_radix(v.as_str().unwrap(), 10).unwrap()
}

fn hex(bytes: &[u8]) -> String {
    let digits: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("0x{digits}")
}

fn countersign(m: &Value) -> Countersign {
    Countersign {
        requestId: b32(&m["requestId"]),
        mandateHash: b32(&m["mandateHash"]),
        mandateCommitment: b32(&m["mandateCommitment"]),
        cartHash: b32(&m["cartHash"]),
        agentId: uint(&m["agentId"]),
        merchantId: b32(&m["merchantId"]),
        amount: uint(&m["amount"]).to(),
        currency: uint(&m["currency"]).to(),
        category: uint(&m["category"]).to(),
        evidenceRoot: b32(&m["evidenceRoot"]),
        evalHash: b32(&m["evalHash"]),
        policySetHash: b32(&m["policySetHash"]),
        decision: uint(&m["decision"]).to(),
        failedFieldsMask: uint(&m["failedFieldsMask"]).to(),
        issuedAt: uint(&m["issuedAt"]).to(),
        expiresAt: uint(&m["expiresAt"]).to(),
    }
}

#[test]
fn countersign_vectors() {
    let vectors = load(include_str!(
        "../../../packages/core/test/vectors/countersign.json"
    ));
    assert_eq!(vectors.len(), 20);
    for v in vectors {
        let d = &v["input"]["domain"];
        let d = domain(
            d["chainId"].as_u64().unwrap(),
            d["verifyingContract"].as_str().unwrap().parse().unwrap(),
        )
        .expect("supported chain");
        let digest = countersign_digest(&countersign(&v["input"]["message"]), &d);
        assert_eq!(hex(&digest), v["expected"]["digest"], "{}", v["name"]);
    }
}

#[test]
fn report_data_vectors() {
    let vectors = load(include_str!(
        "../../../packages/core/test/vectors/report-data.json"
    ));
    assert_eq!(vectors.len(), 5);
    for v in vectors {
        let b = &v["input"]["binding"];
        let binding = SignerBinding {
            chain_id: b["chainId"].as_str().unwrap().parse().unwrap(),
            bond_vault: b["bondVault"].as_str().unwrap().parse().unwrap(),
            tee_kind: match b["teeKind"].as_u64().unwrap() {
                1 => TeeKind::Tdx,
                2 => TeeKind::Nitro,
                k => panic!("unknown tee kind {k}"),
            },
            signer: b["signer"].as_str().unwrap().parse().unwrap(),
            policy_set_hash: b32(&b["policySetHash"]).0,
            engine_build_id: b32(&b["engineBuildId"]).0,
            boot_epoch: b["bootEpoch"].as_str().unwrap().parse().unwrap(),
        };
        let data = report_data(&binding, b32(&v["input"]["blockHash"]).0);
        assert_eq!(hex(&data), v["expected"], "{}", v["name"]);
    }
}

#[test]
fn signatures_are_low_s_and_recover_the_signer() {
    let half_n = U256::from_str_radix(
        "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0",
        16,
    )
    .unwrap();
    let signer = Signer::generate();
    let address = signer.address();
    assert_eq!(
        Address::from_raw_public_key(&signer.public_key_sec1()[1..]),
        address
    );
    for i in 0u64..10_000 {
        let digest = keccak256(i.to_be_bytes());
        let raw = signer.sign_digest(&digest.0);
        assert!(raw[64] == 27 || raw[64] == 28);
        let signature = Signature::from_raw_array(&raw).unwrap();
        assert!(signature.s() <= half_n, "high s at {i}");
        assert_eq!(
            signature.recover_address_from_prehash(&digest).unwrap(),
            address,
            "recovery at {i}"
        );
    }
}

#[test]
fn generated_signers_are_distinct() {
    assert_ne!(Signer::generate().address(), Signer::generate().address());
}

#[test]
fn mask_sets_field_and_fault_bits() {
    assert_eq!(
        failed_fields_mask(&["amount", "variant"], false, false, false),
        (1 << 3) | (1 << 9)
    );
    assert_eq!(failed_fields_mask(&[] as &[&str], false, false, false), 0);
    assert_eq!(
        failed_fields_mask(&["base"], true, true, true),
        (1 << BIT_CEDAR_ERROR) | (1 << BIT_CANON) | (1 << BIT_PAYPAL)
    );
    let all: Vec<String> = FIELD_BITS.iter().map(|(id, _)| id.to_string()).collect();
    assert_eq!(failed_fields_mask(&all, false, false, false), 0xfff);
}

#[test]
fn every_forbid_policy_has_a_bit() {
    for id in keelson_policy::policy_texts().keys() {
        if id == "base" {
            continue;
        }
        assert!(
            FIELD_BITS.iter().any(|(field, _)| field == id),
            "policy {id} has no failedFieldsMask bit"
        );
    }
}
