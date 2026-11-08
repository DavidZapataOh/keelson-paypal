use alloy_primitives::{Address, B256, Signature, U256, keccak256};
use alloy_sol_types::Eip712Domain;
use keelson_core::{domain, eip712::Countersign};
use keelson_tee::wire::Observation;
use keelson_tee::{
    BIT_CANON, BIT_CEDAR_ERROR, BIT_EXTRA, BIT_PAYPAL, Error, FIELD_BITS, Signer, SignerBinding,
    TeeKind, countersign_digest, failed_fields_mask, report_data,
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
    assert_eq!(vectors.len(), 10);
    for v in vectors {
        let b = &v["input"]["binding"];
        let data = TeeKind::try_from(b["teeKind"].as_u64().unwrap() as u8).and_then(|tee_kind| {
            let binding = SignerBinding {
                chain_id: b["chainId"].as_str().unwrap().parse().unwrap(),
                bond_vault: b["bondVault"].as_str().unwrap().parse().unwrap(),
                tee_kind,
                signer: b["signer"].as_str().unwrap().parse().unwrap(),
                policy_set_hash: b32(&b["policySetHash"]).0,
                engine_build_id: b32(&b["engineBuildId"]).0,
                boot_epoch: b["bootEpoch"].as_str().unwrap().parse().unwrap(),
                issuer_jwk_thumbprint: b32(&b["issuerJwkThumbprint"]).0,
            };
            let parsed: SignerBinding = serde_json::from_value(b.clone()).unwrap();
            assert_eq!(parsed, binding, "{}", v["name"]);
            let json = serde_json::to_value(&binding).unwrap();
            assert_eq!(json["signer"], binding.signer.to_checksum(None));
            assert_eq!(json["chainId"], b["chainId"]);
            assert_eq!(json["bootEpoch"], b["bootEpoch"]);
            assert_eq!(
                serde_json::from_value::<SignerBinding>(json).unwrap(),
                binding
            );
            report_data(&binding, b32(&v["input"]["blockHash"]).0)
        });
        match data {
            Ok(data) => assert_eq!(hex(&data), v["expected"], "{}", v["name"]),
            Err(_) => assert_eq!(v["expected"], "error", "{}", v["name"]),
        }
    }
}

#[test]
fn failed_fields_mask_vectors() {
    let vectors = load(include_str!(
        "../../../packages/core/test/vectors/failed-fields-mask.json"
    ));
    assert_eq!(vectors.len(), 10);
    for v in vectors {
        let i = &v["input"];
        let fired: Vec<&str> = i["fired"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.as_str().unwrap())
            .collect();
        let flag = |k: &str| i[k].as_bool().unwrap();
        let mask = failed_fields_mask(&fired, flag("errors"), flag("canon"), flag("paypal"));
        assert_eq!(
            u64::from(mask),
            v["expected"].as_u64().unwrap(),
            "{}",
            v["name"]
        );
    }
}

fn sepolia() -> Eip712Domain {
    domain(421_614, Address::ZERO).unwrap()
}

#[test]
fn signatures_are_low_s_and_recover_the_signer() {
    let half_n = U256::from_str_radix(
        "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0",
        16,
    )
    .unwrap();
    let vectors = load(include_str!(
        "../../../packages/core/test/vectors/countersign.json"
    ));
    let mut c = countersign(&vectors[0]["input"]["message"]);
    let d = sepolia();
    let signer = Signer::generate();
    let address = signer.address();
    assert_eq!(
        Address::from_raw_public_key(&signer.public_key_sec1()[1..]),
        address
    );
    for i in 0u64..10_000 {
        c.requestId = keccak256(i.to_be_bytes());
        let raw = signer.sign_countersign(&c, &d).unwrap();
        assert!(raw[64] == 27 || raw[64] == 28);
        let signature = Signature::from_raw_array(&raw).unwrap();
        assert!(signature.s() <= half_n, "high s at {i}");
        let digest = B256::new(countersign_digest(&c, &d));
        assert_eq!(
            signature.recover_address_from_prehash(&digest).unwrap(),
            address,
            "recovery at {i}"
        );
    }
}

#[test]
fn signing_rejects_unsupported_chains() {
    let vectors = load(include_str!(
        "../../../packages/core/test/vectors/countersign.json"
    ));
    let c = countersign(&vectors[0]["input"]["message"]);
    let signer = Signer::generate();
    let mut d = sepolia();
    d.chain_id = Some(U256::from(1));
    assert_eq!(
        signer.sign_countersign(&c, &d),
        Err(Error::UnsupportedChain(1))
    );
    d.chain_id = None;
    assert!(signer.sign_countersign(&c, &d).is_err());
}

#[test]
fn tee_kind_accepts_only_tdx_and_nitro() {
    assert_eq!(TeeKind::try_from(1), Ok(TeeKind::Tdx));
    assert_eq!(TeeKind::try_from(2), Ok(TeeKind::Nitro));
    assert_eq!(TeeKind::try_from(0), Err(Error::UnknownTeeKind(0)));
    assert_eq!(TeeKind::try_from(3), Err(Error::UnknownTeeKind(3)));
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
    assert_eq!(
        failed_fields_mask(&["extra.0", "extra.7", "amount"], false, false, false),
        (1 << BIT_EXTRA) | (1 << 3)
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

/// The observation leg A forwards to leg B names the PayPal order of the authorization, in the
/// shape leg B parses.
#[test]
fn observation_json_names_the_order() {
    let json = serde_json::json!({
        "now_ms": 1_793_750_470_000_i64,
        "budget_left_minor": 10_000,
        "user_key": {
            "kty": "EC", "crv": "P-256",
            "x": "rG2YAN80tmhPdXxOOH_ZsBqdI97Cf4yJL3H8ZToyX-M",
            "y": "uIq1dTwXYVvt26u9ehj7Itc4yr0f0N89hi4tBE2PVdk"
        },
        "paypal": {
            "authorization_id": "2YE949500W649811X",
            "order_id": "6XX99734C4618040C",
            "status": "CREATED",
            "currency": "USD",
            "authorized_minor": 10_000,
            "captured_minor": 0,
            "payee_merchant_id": "A4WCRYD5EYDF2",
            "expires_at_ms": 1_796_665_574_000_i64,
            "custom_id": "ks1.sm.01JBXG3K5N7Q9R2T4V6W8Y0Z1A.SC4lPIQQS_7hUI1WoHbFiKBE6nmxEfU5sBAD1IV3YDI",
            "raw_authorization": "",
            "raw_order": "",
            "read_at_ms": 1_794_160_222_638_i64
        }
    });
    let o: Observation = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(o.paypal.order_id, "6XX99734C4618040C");
    assert_eq!(serde_json::to_value(&o).unwrap(), json);
}
