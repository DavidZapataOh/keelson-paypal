//! Resident memory after 10,000 countersigns on each leg. Linux only, since it reads
//! `/proc/self/status`; run with `--release --ignored`.

#![cfg(target_os = "linux")]

#[path = "common/mod.rs"]
mod common;

use common::*;
use keelson_tee::process::rss_kib;
use serde_json::json;

const COUNTERSIGNS: u128 = 10_000;
const BUDGET_KIB: u64 = 64 * 1024;
const CLOCK: i64 = NOW + 10;

/// The demo shoes at one cent, so 10,000 of them fit the mandate's budget and every countersign
/// on leg A takes the allow path, reservation included.
fn one_cent() -> CartFixture {
    let mut f = CartFixture::demo();
    f.raw["cart"]["lines"][0]["unit_minor"] = json!(1);
    f.raw["unit"]["amount"]["value"] = json!("0.01");
    f.raw["unit"]["amount"]["breakdown"]["item_total"]["value"] = json!("0.01");
    f
}

#[test]
#[ignore = "10,000 countersigns; run with --release"]
fn rss_after_10000_countersigns_stays_under_the_budget() {
    let issued = register();
    let f = one_cent();
    let leg_a = leg_a();
    let leg_b = leg_b();
    let before = rss_kib().unwrap();
    let mut allowed = [0u32; 2];
    for n in 1..=COUNTERSIGNS {
        let id = request_id(n);
        let a = leg_a
            .countersign(&countersign_request(&issued, &f, id, None), at(CLOCK))
            .unwrap();
        let mut b = countersign_request(&issued, &f, id, Some(observation(CLOCK * 1000)));
        b.closed_mandate = close(&issued.open_mandate, &id.to_string(), &f.hash(), CLOCK);
        let b = leg_b.countersign(&b, at(CLOCK)).unwrap();
        allowed[0] += u32::from(a.countersign.decision == "1");
        allowed[1] += u32::from(b.countersign.decision == "1");
    }
    let after = rss_kib().unwrap();
    println!(
        "allowed: leg A {}, leg B {}; rss before {before} KiB, after {after} KiB",
        allowed[0], allowed[1]
    );
    assert_eq!(allowed, [COUNTERSIGNS as u32; 2]);
    assert!(
        after < BUDGET_KIB,
        "{after} KiB is over the {BUDGET_KIB} KiB budget"
    );
}
