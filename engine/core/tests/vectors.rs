use acir::{AcirField, FieldElement};
use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::SolStruct;
use keelson_core::{
    AlibiFields, Dst, Money, alibi_digest, domain, eip712, from_paypal_value, hash_object,
    poseidon2, to_paypal_value,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Vector {
    name: String,
    input: Value,
    expected: String,
}

fn load(json: &str) -> Vec<Vector> {
    serde_json::from_str(json).expect("vectors file is valid")
}

fn field(hex: &str) -> FieldElement {
    FieldElement::from_hex(hex).expect("valid field element")
}

#[test]
fn hash_vectors() {
    let vectors = load(include_str!(
        "../../../packages/core/test/vectors/hash.json"
    ));
    assert_eq!(vectors.len(), 22);
    for v in vectors {
        let dst = Dst::parse(v.input["dst"].as_str().unwrap()).expect("known dst");
        let digest = hash_object(dst, &v.input["value"]).unwrap();
        assert_eq!(format!("0x{}", hex(&digest)), v.expected, "{}", v.name);
    }
}

#[test]
fn alibi_vectors() {
    let vectors = load(include_str!(
        "../../../packages/core/test/vectors/alibi.json"
    ));
    assert_eq!(vectors.len(), 4);
    for v in vectors {
        let i = &v.input;
        let s = |key: &str| i[key].as_str().unwrap();
        let amount = Money {
            currency: i["amount"]["currency"].as_str().unwrap().into(),
            minor: i["amount"]["minor"].as_str().unwrap().parse().unwrap(),
        };
        let digest = alibi_digest(&AlibiFields {
            mandate_hash: s("mandateHash"),
            cart_hash: s("cartHash"),
            policy_set_hash: s("policySetHash"),
            countersign_digest: s("countersignDigest"),
            merchant_id: s("merchantId"),
            amount: &amount,
            paypal_order_id: i.get("paypalOrderId").map(|o| o.as_str().unwrap()),
        })
        .unwrap();
        assert_eq!(format!("0x{}", hex(&digest)), v.expected, "{}", v.name);
    }
}

#[test]
fn alibi_rejects_amounts_paypal_cannot_represent() {
    let fields = |amount| AlibiFields {
        mandate_hash: "0x11",
        cart_hash: "0x22",
        policy_set_hash: "0x33",
        countersign_digest: "0x44",
        merchant_id: "MERCHANT1",
        amount,
        paypal_order_id: None,
    };
    let huf = Money {
        currency: "HUF".into(),
        minor: 150,
    };
    let xxx = Money {
        currency: "XXX".into(),
        minor: 1,
    };
    assert!(matches!(
        alibi_digest(&fields(&huf)),
        Err(keelson_core::Error::InvalidAmount(_))
    ));
    assert!(matches!(
        alibi_digest(&fields(&xxx)),
        Err(keelson_core::Error::UnsupportedCurrency(_))
    ));
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn uint(v: &Value) -> U256 {
    U256::from_str_radix(v.as_str().unwrap(), 10).unwrap()
}

macro_rules! typed_hash {
    ($ty:ident { $($field:ident : $kind:ident),* $(,)? }, $m:expr, $d:expr) => {{
        let m = $m;
        let value = eip712::$ty {
            $($field: typed_hash!(@parse $kind, &m[stringify!($field)])),*
        };
        value.eip712_signing_hash($d)
    }};
    (@parse b32, $v:expr) => { $v.as_str().unwrap().parse::<B256>().unwrap() };
    (@parse addr, $v:expr) => { $v.as_str().unwrap().parse::<Address>().unwrap() };
    (@parse $kind:ident, $v:expr) => { uint($v).to() };
}

#[test]
fn eip712_vectors() {
    let vectors = load(include_str!(
        "../../../packages/core/test/vectors/eip712.json"
    ));
    assert_eq!(vectors.len(), 16);
    for v in vectors {
        let chain_id = v.input["chainId"].as_u64().unwrap();
        let contract: Address = v.input["verifyingContract"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let d = domain(chain_id, contract).expect("supported chain");
        let m = &v.input["message"];
        let hash = match v.input["primaryType"].as_str().unwrap() {
            "Countersign" => typed_hash!(
                Countersign {
                    requestId: b32,
                    mandateHash: b32,
                    mandateCommitment: b32,
                    cartHash: b32,
                    agentId: u,
                    merchantId: b32,
                    amount: u,
                    currency: u,
                    category: u,
                    evidenceRoot: b32,
                    evalHash: b32,
                    policySetHash: b32,
                    decision: u,
                    failedFieldsMask: u,
                    issuedAt: u,
                    expiresAt: u,
                },
                m,
                &d
            ),
            "Verdict" => typed_hash!(
                Verdict {
                    disputeId: b32,
                    coverageId: b32,
                    agentId: u,
                    payee: addr,
                    amount: u,
                    ruleId: u,
                    liable: u,
                    fieldId: u,
                    evidenceHash: b32,
                    inputsHash: b32,
                    policySetHash: b32,
                    checkpointRoot: b32,
                    issuedAt: u,
                    deadline: u,
                },
                m,
                &d
            ),
            "Checkpoint" => typed_hash!(
                Checkpoint {
                    origin: b32,
                    treeSize: u,
                    rootHash: b32,
                },
                m,
                &d
            ),
            "Coverage" => typed_hash!(
                Coverage {
                    coverageId: b32,
                    agentId: u,
                    merchant: addr,
                    amount: u,
                    expiresAt: u,
                    mandateHash: b32,
                    amberCommitment: b32,
                },
                m,
                &d
            ),
            "AmberAttestation" => typed_hash!(
                AmberAttestation {
                    coverageId: b32,
                    agentId: u,
                    amberCommitment: b32,
                },
                m,
                &d
            ),
            "WithdrawalRequest" => typed_hash!(
                WithdrawalRequest {
                    agentId: u,
                    amount: u,
                    to: addr,
                    nonce: u,
                    deadline: u,
                },
                m,
                &d
            ),
            "PayoutAddress" => typed_hash!(
                PayoutAddress {
                    merchant: addr,
                    payout: addr,
                    nonce: u,
                    deadline: u,
                },
                m,
                &d
            ),
            "WebFact" => typed_hash!(
                WebFact {
                    hostHash: b32,
                    urlPathHash: b32,
                    tCapture: u,
                    rangeCommitment: b32,
                    attId: b32,
                },
                m,
                &d
            ),
            other => panic!("unknown primary type {other}"),
        };
        assert_eq!(format!("{hash:#x}"), v.expected, "{}", v.name);
    }
}

#[test]
fn rejects_unsupported_chain() {
    assert!(domain(1, Address::ZERO).is_err());
}

#[test]
fn poseidon2_vectors() {
    let vectors = load(include_str!(
        "../../../packages/core/test/vectors/poseidon2.json"
    ));
    assert_eq!(vectors.len(), 12);
    for v in vectors {
        let inputs: Vec<FieldElement> = v
            .input
            .as_array()
            .unwrap()
            .iter()
            .map(|x| field(x.as_str().unwrap()))
            .collect();
        assert_eq!(poseidon2(&inputs), field(&v.expected), "{}", v.name);
    }
}

#[test]
fn money_vectors() {
    let vectors = load(include_str!(
        "../../../packages/core/test/vectors/money.json"
    ));
    for v in vectors {
        let currency = v.input["currency"].as_str().unwrap();
        let actual = match v.input["op"].as_str().unwrap() {
            "toPayPalValue" => {
                let minor: i128 = v.input["minor"].as_str().unwrap().parse().unwrap();
                to_paypal_value(&Money {
                    currency: currency.into(),
                    minor,
                })
            }
            "fromPayPalValue" => from_paypal_value(currency, v.input["value"].as_str().unwrap())
                .map(|m| m.minor.to_string()),
            op => panic!("unknown op {op}"),
        };
        assert_eq!(
            actual.unwrap_or_else(|_| "error".into()),
            v.expected,
            "{}",
            v.name
        );
    }
}

#[test]
fn jcs_raw_vectors() {
    let vectors = load(include_str!(
        "../../../packages/core/test/vectors/jcs-raw.json"
    ));
    for v in vectors {
        let source = v.input.as_str().unwrap();
        let actual = serde_json::from_str::<Value>(source)
            .map_err(|_| ())
            .and_then(|value| keelson_core::jcs(&value).map_err(|_| ()));
        assert_eq!(
            actual.unwrap_or_else(|()| "error".into()),
            v.expected,
            "{}",
            v.name
        );
    }
}

#[test]
fn jcs_integer_bounds() {
    use keelson_core::{Error, jcs};
    use serde_json::json;
    assert_eq!(jcs(&json!([i64::MIN])), Err(Error::UnsafeInteger));
    assert_eq!(jcs(&json!([i64::MAX])), Err(Error::UnsafeInteger));
    assert_eq!(
        jcs(&json!([-9_007_199_254_740_991_i64])).unwrap(),
        "[-9007199254740991]"
    );
    assert_eq!(jcs(&json!([u64::MAX])), Err(Error::UnsafeInteger));
    assert_eq!(
        jcs(&json!([9_007_199_254_740_993_u64])),
        Err(Error::UnsafeInteger)
    );
    assert_eq!(jcs(&json!([-0.0])).unwrap(), "[0]");
}

#[test]
fn jcs_rejects_non_canonical_numbers() {
    use keelson_core::{Error, jcs};
    use serde_json::json;
    assert_eq!(jcs(&json!({"n": 1.5})), Err(Error::NonInteger));
    assert_eq!(
        jcs(&json!([9_007_199_254_740_992_i64])),
        Err(Error::UnsafeInteger)
    );
    assert_eq!(
        jcs(&json!([-9_007_199_254_740_992_i64])),
        Err(Error::UnsafeInteger)
    );
    assert_eq!(jcs(&json!([u64::MAX])), Err(Error::UnsafeInteger));
    assert_eq!(
        jcs(&json!([9_007_199_254_740_991_i64])).unwrap(),
        "[9007199254740991]"
    );
}
