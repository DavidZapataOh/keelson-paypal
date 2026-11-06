//! Kani proofs of the canonicalizer's arithmetic core: the line sum and the breakdown adjustments,
//! for every `i64` input.
//!
//! Decimal parsing, per-variant quantities, the reconciled total and panic freedom of
//! `canonicalize` on whole carts are covered by the property tests in `tests/properties.rs`
//! instead: CBMC does not scale to the strings and B-tree maps they involve.

use crate::{Deny, MAX_LINES, breakdown_total, sum_minor};

/// `qty × unit_minor` in `i128`. The product of two `i64` always fits, so it cannot wrap.
fn product((qty, unit_minor): (i64, i64)) -> i128 {
    (qty as i128).wrapping_mul(unit_minor as i128)
}

/// The result `sum_minor` must return, computed in `i128`.
fn reference_sum(lines: &[(i64, i64)]) -> Result<i64, Deny> {
    let mut sum = 0i128;
    for &(qty, unit_minor) in lines {
        if qty < 1 {
            return Err(Deny::InvalidQuantity);
        }
        if unit_minor < 0 {
            return Err(Deny::InvalidAmount);
        }
        sum += product((qty, unit_minor));
        if sum > i64::MAX as i128 {
            return Err(Deny::AmountOverflow);
        }
    }
    Ok(sum as i64)
}

#[kani::proof]
#[kani::unwind(17)]
fn sum_minor_no_overflow_or_panic() {
    let lines: [(i64, i64); MAX_LINES] = kani::any();
    assert!(sum_minor(lines) == reference_sum(&lines));
}

#[kani::proof]
#[kani::unwind(17)]
fn breakdown_total_matches_i128() {
    let item_total: i64 = kani::any();
    let additions: [i64; 4] = kani::any();
    let deductions: [i64; 2] = kani::any();
    let exact = item_total as i128 + additions.iter().map(|&a| a as i128).sum::<i128>()
        - deductions.iter().map(|&d| d as i128).sum::<i128>();
    match breakdown_total(item_total, additions, deductions) {
        Ok(total) => assert!(total as i128 == exact),
        Err(deny) => assert!(deny == Deny::AmountOverflow),
    }
}
