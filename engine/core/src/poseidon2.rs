use acir::{AcirField, FieldElement};

use crate::Error;
use bn254_blackbox_solver::poseidon2_permutation;

const RATE: usize = 3;

fn permute(state: [FieldElement; 4]) -> [FieldElement; 4] {
    poseidon2_permutation(&state)
        .expect("the permutation accepts a state of width 4")
        .try_into()
        .expect("the permutation preserves the state width")
}

/// Poseidon2 sponge over BN254 (state 4, rate 3, `iv = len * 2^64`), matching barretenberg.
pub fn poseidon2(inputs: &[FieldElement]) -> FieldElement {
    let in_len = inputs.len();
    let mut state = [FieldElement::zero(); 4];
    state[RATE] = FieldElement::from(in_len as u64) * FieldElement::from(1u128 << 64);

    let (chunks, remainder) = inputs.as_chunks::<RATE>();
    for chunk in chunks {
        for (slot, input) in state.iter_mut().zip(chunk) {
            *slot += *input;
        }
        state = permute(state);
    }

    for (slot, input) in state.iter_mut().zip(remainder) {
        *slot += *input;
    }

    if in_len == 0 || !remainder.is_empty() {
        state = permute(state);
    }

    state[0]
}

/// Interprets up to 31 ASCII bytes as a big-endian field element.
pub fn field_from_ascii(tag: &str) -> Result<FieldElement, Error> {
    if tag.is_empty() || tag.len() > 31 || !tag.is_ascii() {
        return Err(Error::InvalidTag(tag.to_owned()));
    }
    Ok(FieldElement::from_be_bytes_reduce(tag.as_bytes()))
}
