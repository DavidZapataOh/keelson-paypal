use alloy_primitives::FixedBytes;
use alloy_primitives::{Address, B256, U256, aliases::U40};
use alloy_sol_types::SolStruct;
use coset::{CborSerializable, CoseSign1, TaggedCborSerializable};
use keelson_core::eip712::{CardAuthorization, CardSettlement, Countersign};
use keelson_core::statement::{
    CARD_AUTHORIZATION_CONTENT_TYPE, CARD_SETTLEMENT_CONTENT_TYPE, CardAuthorizationClaims,
    CardSettlementClaims, LegSignature, Mode, StatementClaims, card_authorization_claims_bytes,
    card_settlement_claims_bytes, claims_bytes, protected_header, statement, statement_protected,
    to_be_signed,
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

const CARD_VECTORS: [&str; 3] = [
    include_str!("../../../internal/alibilog/testdata/statement-v2/card-auth-approve.json"),
    include_str!("../../../internal/alibilog/testdata/statement-v2/card-auth-decline.json"),
    include_str!("../../../internal/alibilog/testdata/statement-v2/card-settlement.json"),
];

fn legs_of(i: &Value) -> Vec<LegSignature> {
    i["legs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| LegSignature {
            kind: if l["kind"] == "tdx" { 1 } else { 2 },
            signer: fixed(l["signer"].as_str().unwrap()),
            signature: fixed(l["signature"].as_str().unwrap()),
            measurement: fixed(l["measurement"].as_str().unwrap()),
        })
        .collect()
}

#[test]
fn card_statement_vectors_match() {
    for raw in CARD_VECTORS {
        let v: Value = serde_json::from_str(raw).unwrap();
        let i = &v["inputs"];
        let f = &i["facts"];
        let s = |k: &str| f[k].as_str().unwrap();
        let b = |k: &str| B256::from(fixed::<32>(s(k)));
        let n = |k: &str| s(k).parse::<u64>().unwrap();
        let legs = legs_of(i);
        let verifying_contract: Address =
            i["verifying_contract"].as_str().unwrap().parse().unwrap();
        let chain_id = i["chain_id"].as_u64().unwrap();
        let d = keelson_core::domain(chain_id, verifying_contract).unwrap();
        let parent = fixed::<32>(i["parent"].as_str().unwrap());
        let (payload, digest, iat, content_type) = if v["kind"] == "card-authorization" {
            let a = CardAuthorization {
                requestId: b("requestId"),
                countersignDigest: b("countersignDigest"),
                authorizationHash: b("authorizationHash"),
                merchantHash: b("merchantHash"),
                mcc: n("mcc") as u16,
                country: FixedBytes::<2>::from(fixed::<2>(s("country"))),
                amount: n("amount"),
                currency: n("currency") as u16,
                decision: n("decision") as u8,
                failedMask: n("failedMask") as u32,
                issuedAt: U40::from(n("issuedAt")),
            };
            let claims = CardAuthorizationClaims {
                authorization: &a,
                card_ref: fixed(i["card_ref"].as_str().unwrap()),
                parent,
                chain_id,
                verifying_contract: verifying_contract.into_array(),
                mode: Mode::TwoOfTwo,
                legs: &legs,
            };
            (
                card_authorization_claims_bytes(&claims),
                a.eip712_signing_hash(&d),
                n("issuedAt"),
                CARD_AUTHORIZATION_CONTENT_TYPE,
            )
        } else {
            let t = CardSettlement {
                requestId: b("requestId"),
                cardRef: b("cardRef"),
                transactionHash: b("transactionHash"),
                settledMinor: n("settledMinor"),
                currency: n("currency") as u16,
                status: n("status") as u8,
                settledAt: U40::from(n("settledAt")),
                observedAt: U40::from(n("observedAt")),
            };
            let claims = CardSettlementClaims {
                settlement: &t,
                parent,
                chain_id,
                verifying_contract: verifying_contract.into_array(),
                mode: Mode::TwoOfTwo,
                legs: &legs,
            };
            (
                card_settlement_claims_bytes(&claims),
                t.eip712_signing_hash(&d),
                n("observedAt"),
                CARD_SETTLEMENT_CONTENT_TYPE,
            )
        };
        assert_eq!(hex_of(&payload), v["claims_hex"], "{} claims", v["name"]);
        assert_eq!(
            hex_of(digest.as_slice()),
            v["digest_hex"],
            "{} digest",
            v["name"]
        );
        let protected = protected_header(
            legs[1].signer,
            i["alibi_id"].as_str().unwrap(),
            iat,
            content_type,
        );
        assert_eq!(
            hex_of(&protected),
            v["protected_hex"],
            "{} protected",
            v["name"]
        );
        let decoded =
            CoseSign1::from_tagged_slice(&hex_bytes(v["statement_hex"].as_str().unwrap())).unwrap();
        let signature: [u8; 64] = decoded.signature.clone().try_into().unwrap();
        assert_eq!(
            hex_of(&statement(protected, payload, signature)),
            v["statement_hex"],
            "{} statement",
            v["name"]
        );
    }
}

#[test]
fn bridge_vectors_match() {
    for raw in [
        include_str!("../../../internal/alibilog/testdata/statement-v2/bridge-2of2.json"),
        include_str!("../../../internal/alibilog/testdata/statement-v2/bridge-degraded.json"),
    ] {
        let v: Value = serde_json::from_str(raw).unwrap();
        let i = &v["inputs"];
        let cs = countersign(&i["countersign"]);
        let legs = legs_of(i);
        let verifying_contract: Address =
            i["verifying_contract"].as_str().unwrap().parse().unwrap();
        let claims = keelson_core::statement::BridgeClaims {
            countersign: &cs,
            chain_id: i["chain_id"].as_u64().unwrap(),
            verifying_contract: verifying_contract.into_array(),
            mode: if i["mode"] == "2of2" {
                Mode::TwoOfTwo
            } else {
                Mode::Degraded
            },
            legs: &legs,
            predecessor: fixed(i["predecessor"].as_str().unwrap()),
        };
        let payload = keelson_core::statement::bridge_claims_bytes(&claims);
        assert_eq!(hex_of(&payload), v["claims_hex"], "{} claims", v["name"]);
        let protected = protected_header(
            fixed(i["bridge_signer"].as_str().unwrap()),
            i["alibi_id"].as_str().unwrap(),
            cs.issuedAt.to::<u64>(),
            keelson_core::statement::BRIDGE_CONTENT_TYPE,
        );
        assert_eq!(
            hex_of(&protected),
            v["protected_hex"],
            "{} protected",
            v["name"]
        );
        let decoded =
            CoseSign1::from_tagged_slice(&hex_bytes(v["statement_hex"].as_str().unwrap())).unwrap();
        let signature: [u8; 64] = decoded.signature.clone().try_into().unwrap();
        assert_eq!(
            hex_of(&statement(protected, payload, signature)),
            v["statement_hex"],
            "{} statement",
            v["name"]
        );
    }
}

#[test]
fn receipt_protected_matches_the_typescript_one() {
    let v: Value = serde_json::from_str(include_str!(
        "../../../internal/scitt/testdata/receipt.json"
    ))
    .unwrap();
    let public: [u8; 32] = fixed(v["public_key_hex"].as_str().unwrap());
    let protected =
        keelson_core::statement::receipt_protected(&public, v["origin"].as_str().unwrap());
    assert_eq!(hex_of(&protected), v["protected_hex"]);
    let root: [u8; 32] = fixed(v["root_hex"].as_str().unwrap());
    let tbs = to_be_signed(&protected, &root);
    assert_eq!(&hex_of(&tbs)[..24], "846a5369676e617475726531");
}

#[test]
fn receipts_match_and_verify_against_the_typescript_ones() {
    use keelson_core::statement::{
        build_receipt, leaf_hash, receipt_protected, root_from_inclusion, verify_receipt,
    };
    let v: Value = serde_json::from_str(include_str!(
        "../../../internal/scitt/testdata/receipt.json"
    ))
    .unwrap();
    let public: [u8; 32] = fixed(v["public_key_hex"].as_str().unwrap());
    let origin = v["origin"].as_str().unwrap();
    let entries: Vec<Vec<u8>> = v["entries_hex"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| hex_bytes(e.as_str().unwrap()))
        .collect();
    let root: [u8; 32] = fixed(v["root_hex"].as_str().unwrap());
    for (i, expected) in v["receipts_hex"].as_array().unwrap().iter().enumerate() {
        let bytes = hex_bytes(expected.as_str().unwrap());
        let out = verify_receipt(&bytes, &entries[i], &[public]).expect("the receipt verifies");
        assert_eq!(
            (out.size, out.index, out.root),
            (entries.len() as u64, i as u64, root)
        );
        let decoded = CoseSign1::from_tagged_slice(&bytes).unwrap();
        let sig: [u8; 64] = decoded.signature.clone().try_into().unwrap();
        let rebuilt = build_receipt(
            &receipt_protected(&public, origin),
            sig,
            out.size,
            out.index,
            &out.path,
        );
        assert_eq!(hex_of(&rebuilt), expected.as_str().unwrap(), "receipt {i}");
        let mut wrong = entries[i].clone();
        wrong.push(0);
        assert!(verify_receipt(&bytes, &wrong, &[public]).is_none());
        assert!(verify_receipt(&bytes, &entries[i], &[[0; 32]]).is_none());
        assert_eq!(
            root_from_inclusion(&leaf_hash(&entries[i]), out.index, out.size, &out.path),
            Some(root)
        );
    }
}

#[test]
fn reads_back_the_purchase_claims_it_wrote() {
    for (name, raw) in VECTORS {
        let v: Value = serde_json::from_str(raw).unwrap();
        let read = keelson_core::statement::read_purchase(&hex_bytes(
            v["statement_hex"].as_str().unwrap(),
        ))
        .expect(name);
        assert_eq!(hex_of(&read.claims_bytes), v["claims_hex"], "{name}");
        assert_eq!(read.alibi_id, v["inputs"]["alibi_id"], "{name}");
        assert_eq!(
            read.legs.len(),
            v["inputs"]["legs"].as_array().unwrap().len(),
            "{name}"
        );
        assert_eq!(
            read.countersign.amount.to_string(),
            v["inputs"]["countersign"]["amount"],
            "{name}"
        );
        assert_eq!(read.chain_id, v["inputs"]["chain_id"].as_u64().unwrap());
    }
}

#[test]
fn reads_back_a_bridge_statement_with_its_predecessor() {
    for name in ["bridge-2of2", "bridge-degraded"] {
        let raw = std::fs::read_to_string(format!(
            "{}/../../internal/alibilog/testdata/statement-v2/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        let read = keelson_core::statement::read_purchase(&hex_bytes(
            v["statement_hex"].as_str().unwrap(),
        ))
        .expect(name);
        assert_eq!(hex_of(&read.claims_bytes), v["claims_hex"], "{name}");
        assert_eq!(
            format!("0x{}", hex_of(&read.predecessor.unwrap())),
            v["inputs"]["predecessor"],
            "{name}"
        );
        assert!(read.pay_ref.is_none());
    }
}
