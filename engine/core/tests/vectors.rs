use acir::{AcirField, FieldElement};
use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::SolStruct;
use keelson_core::{
    Dst, Money, domain, eip712, from_paypal_value, hash_object, poseidon2, to_paypal_value,
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
    assert_eq!(vectors.len(), 20);
    for v in vectors {
        let dst = Dst::parse(v.input["dst"].as_str().unwrap()).expect("known dst");
        let digest = hash_object(dst, &v.input["value"]).unwrap();
        assert_eq!(format!("0x{}", hex(&digest)), v.expected, "{}", v.name);
    }
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
