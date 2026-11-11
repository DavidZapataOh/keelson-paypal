use alloy_primitives::{Address, B256, U256, aliases::U40};
use coset::{CborSerializable, CoseSign1, TaggedCborSerializable};
use keelson_core::eip712::Countersign;
use keelson_core::statement::{
    LegSignature, Mode, StatementClaims, claims_bytes, statement, statement_protected, to_be_signed,
};
use serde_json::Value;

const VECTORS: [(&str, &str); 4] = [
    (
        "allow-2of2",
        include_str!("../../../internal/alibilog/testdata/statement-v2/allow-2of2.json"),
    ),
    (
        "deny-2of2",
        include_str!("../../../internal/alibilog/testdata/statement-v2/deny-2of2.json"),
    ),
    (
        "allow-degraded",
        include_str!("../../../internal/alibilog/testdata/statement-v2/allow-degraded.json"),
    ),
    (
        "card-2of2",
        include_str!("../../../internal/alibilog/testdata/statement-v2/card-2of2.json"),
    ),
];

fn hex_bytes(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn hex_of(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn fixed<const N: usize>(s: &str) -> [u8; N] {
    hex_bytes(s).try_into().unwrap()
}

fn countersign(c: &Value) -> Countersign {
    let s = |k: &str| c[k].as_str().unwrap();
    let b = |k: &str| B256::from(fixed::<32>(s(k)));
    Countersign {
        requestId: b("requestId"),
        mandateHash: b("mandateHash"),
        mandateCommitment: b("mandateCommitment"),
        cartHash: b("cartHash"),
        agentId: U256::from_str_radix(s("agentId"), 10).unwrap(),
        merchantId: b("merchantId"),
        amount: s("amount").parse().unwrap(),
        currency: s("currency").parse().unwrap(),
        category: s("category").parse().unwrap(),
        evidenceRoot: b("evidenceRoot"),
        evalHash: b("evalHash"),
        policySetHash: b("policySetHash"),
        decision: s("decision").parse().unwrap(),
        failedFieldsMask: s("failedFieldsMask").parse().unwrap(),
        issuedAt: U40::from(s("issuedAt").parse::<u64>().unwrap()),
        expiresAt: U40::from(s("expiresAt").parse::<u64>().unwrap()),
    }
}

#[test]
fn statement_vectors_match() {
    for (name, raw) in VECTORS {
        let v: Value = serde_json::from_str(raw).unwrap();
        let i = &v["inputs"];
        let cs = countersign(&i["countersign"]);
        let legs: Vec<LegSignature> = i["legs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| LegSignature {
                kind: if l["kind"] == "tdx" { 1 } else { 2 },
                signer: fixed(l["signer"].as_str().unwrap()),
                signature: fixed(l["signature"].as_str().unwrap()),
                measurement: fixed(l["measurement"].as_str().unwrap()),
            })
            .collect();
        let mode = if i["mode"] == "2of2" {
            Mode::TwoOfTwo
        } else {
            Mode::Degraded
        };
        let verifying_contract: Address =
            i["verifying_contract"].as_str().unwrap().parse().unwrap();
        let claims = StatementClaims {
            countersign: &cs,
            chain_id: i["chain_id"].as_u64().unwrap(),
            verifying_contract: verifying_contract.into_array(),
            mode,
            legs: &legs,
            pay_ref: i["pay_ref"].as_str().map(fixed::<32>),
        };
        let payload = claims_bytes(&claims);
        assert_eq!(hex_of(&payload), v["claims_hex"], "{name} claims");
        let signer = legs.last().unwrap().signer;
        let protected = statement_protected(
            signer,
            i["alibi_id"].as_str().unwrap(),
            cs.issuedAt.to::<u64>(),
        );
        assert_eq!(hex_of(&protected), v["protected_hex"], "{name} protected");
        let tbs = to_be_signed(&protected, &payload);
        assert_eq!(hex_of(&tbs), v["tbs_hex"], "{name} tbs");

        let expected = hex_bytes(v["statement_hex"].as_str().unwrap());
        let decoded = CoseSign1::from_tagged_slice(&expected).unwrap();
        assert_eq!(
            hex_of(&decoded.tbs_data(b"")),
            v["tbs_hex"],
            "{name} coset tbs"
        );
        let signature: [u8; 64] = decoded.signature.clone().try_into().unwrap();
        assert_eq!(
            hex_of(&statement(protected, payload, signature)),
            v["statement_hex"],
            "{name} statement"
        );
        let _ = decoded.to_vec().unwrap();
    }
}

#[test]
fn agent_id_above_u64_is_a_tag_2_bignum() {
    let v: Value = serde_json::from_str(VECTORS[0].1).unwrap();
    let mut cs = countersign(&v["inputs"]["countersign"]);
    cs.agentId = U256::MAX;
    let legs: Vec<LegSignature> = vec![];
    let claims = StatementClaims {
        countersign: &cs,
        chain_id: 421_614,
        verifying_contract: [0; 20],
        mode: Mode::Degraded,
        legs: &legs,
        pay_ref: None,
    };
    let hex = hex_of(&claims_bytes(&claims));
    assert!(hex.contains(&format!("06c25820{}", "ff".repeat(32))));
}
