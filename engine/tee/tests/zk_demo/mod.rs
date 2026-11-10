//! The shared C1 prover and the demo mandate's statement and opening, for the C1 test binaries.
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use acir::FieldElement;
use keelson_mandate::{mandate_opening, merchant_leaf, merchant_membership};
use keelson_tee::zk::{Prover, Statement};
use serde_json::Value;

pub fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn read(path: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(repo().join(path)).unwrap()).unwrap()
}

pub fn shared() -> &'static Arc<Prover> {
    static PROVER: OnceLock<Arc<Prover>> = OnceLock::new();
    PROVER.get_or_init(|| {
        let bb = std::env::var("KEELSON_BB").expect("KEELSON_BB names the bb binary");
        Arc::new(Prover::spawn(bb.as_ref()).unwrap())
    })
}

pub fn prover() -> &'static Prover {
    shared()
}

pub fn field(v: &Value) -> FieldElement {
    FieldElement::try_from_str(v.as_str().unwrap()).unwrap()
}

pub struct Demo {
    pub statement: Statement,
    pub opening: keelson_mandate::MandateOpening,
    pub merchant: keelson_mandate::MembershipProof,
    pub vector: Value,
}

pub fn demo() -> Demo {
    let vector = read("packages/mandate/test/vectors/c1.json");
    let mandate = read("packages/mandate/test/fixtures/demo-mandate.json");
    let salt: [u8; 16] = std::array::from_fn(|i| i as u8 + 1);
    let opening = mandate_opening(&mandate, salt).unwrap();
    let merchant = merchant_membership(&opening.merchants, "mrc_runfast").unwrap();
    let i = &vector["inputs"];
    let int = |k: &str| i[k].as_str().unwrap().parse::<u64>().unwrap();
    let statement = Statement {
        c_m: opening.commitment(),
        amount: int("amount"),
        currency: int("currency") as u16,
        category: int("category") as u8,
        merchant_id: merchant_leaf("mrc_runfast").unwrap(),
        now: int("now"),
        cart_hash: field(&i["cart_hash"]),
        operator_id: opening.operator_id,
    };
    Demo {
        statement,
        opening,
        merchant,
        vector,
    }
}
