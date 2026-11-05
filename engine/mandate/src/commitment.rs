use std::cmp::Ordering;
use std::sync::OnceLock;

use keelson_core::{AcirField, currency_numeric, field_from_ascii, poseidon2};
use serde_json::Value;

use crate::{Error, Fr, b64, parse_mandate};

const DEPTH: usize = 8;
const CHUNK: usize = 31;
const BN254_FR_MODULUS: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";

/// Merchants a tree holds: every slot of the depth-8 tree except the zero leaf at index 0.
pub const MERCHANT_TREE_CAPACITY: usize = (1 << DEPTH) - 1;

/// Category bit table, version `v1`. Bit `i` of a category mask stands for `CATEGORY_IDS[i]`;
/// entries are only ever appended. Ids are Google Product Taxonomy ids (taxonomy version
/// 2021-09-21): the 21 top-level categories in taxonomy order, then `gpt:187` (Shoes).
pub const CATEGORY_IDS: [&str; 22] = [
    "gpt:1", "gpt:166", "gpt:8", "gpt:537", "gpt:111", "gpt:141", "gpt:222", "gpt:412", "gpt:436",
    "gpt:632", "gpt:469", "gpt:536", "gpt:5181", "gpt:772", "gpt:783", "gpt:922", "gpt:5605",
    "gpt:2092", "gpt:988", "gpt:1239", "gpt:888", "gpt:187",
];

const ALL_CATEGORIES: u64 = (1 << CATEGORY_IDS.len()) - 1;

fn tag(name: &str) -> Fr {
    field_from_ascii(name).expect("tags are short ASCII")
}

/// Orders field elements as integers.
fn cmp(a: &Fr, b: &Fr) -> Ordering {
    a.to_be_bytes().cmp(&b.to_be_bytes())
}

/// Maps a merchant id to a field: `poseidon2([KEELSON_MERCHANT, c_0, …, c_k])` where `c_i` are
/// the UTF-8 bytes in consecutive 31-byte chunks, each read big-endian. NUL is rejected so that
/// no chunk starts with a zero byte, which makes the chunk encoding injective.
pub fn merchant_leaf(merchant_id: &str) -> Result<Fr, Error> {
    if merchant_id.is_empty() {
        return Err(Error::Commitment("empty merchant id".into()));
    }
    if merchant_id.contains('\0') {
        return Err(Error::Commitment("merchant id contains NUL".into()));
    }
    let mut inputs = vec![tag("KEELSON_MERCHANT")];
    inputs.extend(
        merchant_id
            .as_bytes()
            .chunks(CHUNK)
            .map(Fr::from_be_bytes_reduce),
    );
    Ok(poseidon2(&inputs))
}

/// Indexed Merkle tree leaf, as in Aztec's nullifier tree: `next_index = 0` and `next = 0`
/// together mean the leaf holds the largest value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeafPreimage {
    pub value: Fr,
    pub next: Fr,
    pub next_index: usize,
}

impl LeafPreimage {
    fn empty() -> Self {
        Self {
            value: Fr::zero(),
            next: Fr::zero(),
            next_index: 0,
        }
    }

    fn is_empty(&self) -> bool {
        *self == Self::empty()
    }

    /// `poseidon2([value, next, next_index])`, and 0 for the empty preimage (Aztec's convention).
    fn hash(&self) -> Fr {
        if self.is_empty() {
            Fr::zero()
        } else {
            poseidon2(&[self.value, self.next, Fr::from(self.next_index as u128)])
        }
    }
}

/// Ordered merchant tree, built by [`merchant_tree`]. Leaf `i + 1` of the tree holds the `i`-th
/// smallest merchant field, and leaf 0 holds the zero value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MerchantTree {
    root: Fr,
    leaves: Vec<Fr>,
    layers: Vec<Vec<Fr>>,
}

impl MerchantTree {
    pub fn root(&self) -> Fr {
        self.root
    }

    /// The merchant fields in ascending order.
    pub fn leaves(&self) -> &[Fr] {
        &self.leaves
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MembershipProof {
    pub leaf: LeafPreimage,
    pub path: Vec<Fr>,
    pub index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NonMembershipProof {
    pub low: LeafPreimage,
    pub path: Vec<Fr>,
    pub index: usize,
}

/// Roots of empty subtrees by height: `z_0 = 0`, `z_{h+1} = poseidon2([z_h, z_h])`.
fn zero_subtrees() -> &'static [Fr; DEPTH + 1] {
    static ZEROES: OnceLock<[Fr; DEPTH + 1]> = OnceLock::new();
    ZEROES.get_or_init(|| {
        let mut z = [Fr::zero(); DEPTH + 1];
        for h in 0..DEPTH {
            z[h + 1] = poseidon2(&[z[h], z[h]]);
        }
        z
    })
}

fn preimage_at(leaves: &[Fr], index: usize) -> LeafPreimage {
    if index > leaves.len() {
        return LeafPreimage::empty();
    }
    let last = index == leaves.len();
    LeafPreimage {
        value: if index == 0 {
            Fr::zero()
        } else {
            leaves[index - 1]
        },
        next: if last { Fr::zero() } else { leaves[index] },
        next_index: if last { 0 } else { index + 1 },
    }
}

/// Builds the depth-8 ordered (indexed) Merkle tree of the given merchant ids, with inner nodes
/// `poseidon2([left, right])`. Leaf 0 is the zero leaf, so a non-membership proof is a single
/// low-leaf opening even below the smallest id. Fails on no ids, duplicates, or more than
/// [`MERCHANT_TREE_CAPACITY`].
pub fn merchant_tree<S: AsRef<str>>(ids: &[S]) -> Result<MerchantTree, Error> {
    if ids.is_empty() {
        return Err(Error::Commitment("no merchants".into()));
    }
    if ids.len() > MERCHANT_TREE_CAPACITY {
        return Err(Error::Commitment(format!(
            "more than {MERCHANT_TREE_CAPACITY} merchants"
        )));
    }
    let mut leaves = ids
        .iter()
        .map(|id| merchant_leaf(id.as_ref()))
        .collect::<Result<Vec<_>, _>>()?;
    leaves.sort_by(cmp);
    if leaves.windows(2).any(|w| w[0] == w[1]) {
        return Err(Error::Commitment("duplicate merchant id".into()));
    }
    let z = zero_subtrees();
    let mut layer = vec![Fr::zero(); 1 << DEPTH];
    for (i, node) in layer.iter_mut().enumerate().take(leaves.len() + 1) {
        *node = preimage_at(&leaves, i).hash();
    }
    let mut layers = vec![layer];
    for h in 0..DEPTH {
        let next = layers[h]
            .chunks(2)
            .map(|pair| match pair {
                [l, r] if *l == z[h] && *r == z[h] => z[h + 1],
                [l, r] => poseidon2(&[*l, *r]),
                _ => unreachable!("layers have even width"),
            })
            .collect();
        layers.push(next);
    }
    Ok(MerchantTree {
        root: layers[DEPTH][0],
        leaves,
        layers,
    })
}

/// The root of [`merchant_tree`].
pub fn merchant_root<S: AsRef<str>>(ids: &[S]) -> Result<Fr, Error> {
    merchant_tree(ids).map(|tree| tree.root)
}

fn path_of(tree: &MerchantTree, index: usize) -> Vec<Fr> {
    (0..DEPTH)
        .map(|h| tree.layers[h][(index >> h) ^ 1])
        .collect()
}

fn opens(root: &Fr, leaf: &LeafPreimage, index: usize, path: &[Fr]) -> bool {
    if index >= 1 << DEPTH || path.len() != DEPTH {
        return false;
    }
    let node = path
        .iter()
        .enumerate()
        .fold(leaf.hash(), |node, (h, sibling)| {
            if (index >> h) & 1 == 1 {
                poseidon2(&[*sibling, node])
            } else {
                poseidon2(&[node, *sibling])
            }
        });
    node == *root
}

/// Opens the leaf holding `id`. Fails if `id` is not in the tree.
pub fn merchant_membership(tree: &MerchantTree, id: &str) -> Result<MembershipProof, Error> {
    let v = merchant_leaf(id)?;
    let i = tree
        .leaves
        .iter()
        .position(|x| *x == v)
        .ok_or_else(|| Error::Commitment("merchant is not in the tree".into()))?;
    Ok(MembershipProof {
        leaf: preimage_at(&tree.leaves, i + 1),
        path: path_of(tree, i + 1),
        index: i + 1,
    })
}

/// Opens the low leaf of `id`: the leaf with the largest value below it, whose `next` is above
/// it or 0. Fails if `id` is in the tree.
pub fn merchant_non_membership(tree: &MerchantTree, id: &str) -> Result<NonMembershipProof, Error> {
    let v = merchant_leaf(id)?;
    if tree.leaves.contains(&v) {
        return Err(Error::Commitment("merchant is in the tree".into()));
    }
    let index = tree
        .leaves
        .iter()
        .filter(|x| cmp(x, &v) == Ordering::Less)
        .count();
    Ok(NonMembershipProof {
        low: preimage_at(&tree.leaves, index),
        path: path_of(tree, index),
        index,
    })
}

/// Checks that `proof` opens a leaf of `root` whose value is `id`'s field.
pub fn verify_merchant_membership(
    root: &Fr,
    id: &str,
    proof: &MembershipProof,
) -> Result<bool, Error> {
    Ok(
        proof.leaf.value == merchant_leaf(id)?
            && opens(root, &proof.leaf, proof.index, &proof.path),
    )
}

/// Checks that `proof` opens a non-empty leaf of `root` with `low.value < id < low.next` (or no
/// next). The low leaf must not be the empty preimage: it hashes to 0 like every unused slot and
/// would otherwise pass as a low leaf for any id.
pub fn verify_merchant_non_membership(
    root: &Fr,
    id: &str,
    proof: &NonMembershipProof,
) -> Result<bool, Error> {
    let v = merchant_leaf(id)?;
    let low = &proof.low;
    let last = low.next.is_zero() && low.next_index == 0;
    Ok(!low.is_empty()
        && cmp(&low.value, &v) == Ordering::Less
        && (last || cmp(&v, &low.next) == Ordering::Less)
        && opens(root, low, proof.index, &proof.path))
}

/// Sets bit `i` for every category whose position in [`CATEGORY_IDS`] is `i`.
pub fn category_mask<S: AsRef<str>>(categories: &[S]) -> Result<u64, Error> {
    categories.iter().try_fold(0, |mask, c| {
        let i = CATEGORY_IDS
            .iter()
            .position(|id| *id == c.as_ref())
            .ok_or_else(|| Error::Commitment(format!("unknown category {}", c.as_ref())))?;
        Ok(mask | 1 << i)
    })
}

fn find_constraint<'a>(constraints: &'a Value, ty: &str) -> Option<&'a Value> {
    constraints
        .as_array()?
        .iter()
        .find(|c| c.get("type").and_then(Value::as_str) == Some(ty))
}

fn str_items(v: &Value) -> Vec<&str> {
    v.as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// The mandate's allowed categories minus `deny`; without a category constraint, every category.
fn mandate_category_mask(m: &Value) -> Result<u64, Error> {
    match find_constraint(&m["checkout"]["constraints"], "keelson.category") {
        None => Ok(ALL_CATEGORIES),
        Some(c) => {
            Ok(category_mask(&str_items(&c["allow"]))? & !category_mask(&str_items(&c["deny"]))?)
        }
    }
}

/// Reads the canonical unpadded base64url encoding of exactly `N` bytes.
fn b64_bytes<const N: usize>(s: &str) -> Result<[u8; N], Error> {
    b64::decode_canonical(s)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| Error::Commitment(format!("not {N} bytes of canonical base64url")))
}

/// `poseidon2([x_hi, x_lo, y_hi, y_lo])`: each 32-byte P-256 coordinate split into two 128-bit
/// big-endian limbs, which is injective and matches a circuit taking the key as `[u8; 32]` pairs.
pub fn user_key_hash(x: &str, y: &str) -> Result<Fr, Error> {
    let x = b64_bytes::<32>(x)?;
    let y = b64_bytes::<32>(y)?;
    let limbs = [&x[..16], &x[16..], &y[..16], &y[16..]].map(Fr::from_be_bytes_reduce);
    Ok(poseidon2(&limbs))
}

/// A canonical decimal below the field modulus.
fn operator_id(agent_id: &str) -> Result<Fr, Error> {
    let canonical = agent_id == "0"
        || (!agent_id.starts_with('0')
            && !agent_id.is_empty()
            && agent_id.bytes().all(|b| b.is_ascii_digit()));
    let below = (agent_id.len(), agent_id) < (BN254_FR_MODULUS.len(), BN254_FR_MODULUS);
    if !canonical || !below {
        return Err(Error::Commitment(
            "operator id is not a field element".into(),
        ));
    }
    Fr::try_from_str(agent_id).ok_or_else(|| Error::Commitment("operator id".into()))
}

/// `C_m = poseidon2([KEELSON_MANDATE, user_key_hash, max_amount, currency_num, category_mask,
/// merchant_root, expiry, operator_id, nonce, salt])`, with `nonce` and the 16-byte `salt` read
/// big-endian. The mandate is validated with [`parse_mandate`] first.
pub fn mandate_commitment(m: &Value, salt: [u8; 16]) -> Result<Fr, Error> {
    parse_mandate(m)?;
    let range = find_constraint(&m["payment"]["constraints"], "payment.amount_range");
    let merchants = find_constraint(&m["checkout"]["constraints"], "checkout.allowed_merchants");
    let (Some(range), Some(merchants)) = (range, merchants) else {
        return Err(Error::Commitment(
            "mandate lacks amount_range or allowed_merchants".into(),
        ));
    };
    let operator = operator_id(
        m["agent"]["operator"]["agent_id"]
            .as_str()
            .unwrap_or_default(),
    )?;
    let jwk = &m["user"]["cred"]["jwk"];
    let user_key = user_key_hash(
        jwk["x"].as_str().unwrap_or_default(),
        jwk["y"].as_str().unwrap_or_default(),
    )?;
    let ids: Vec<&str> = merchants["allowed"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x["id"].as_str())
        .collect();
    let root = merchant_root(&ids)?;
    let currency = currency_numeric(m["payment"]["currency"].as_str().unwrap_or_default())?;
    let integer = |v: &Value| Fr::from(v.as_f64().unwrap_or_default() as u128);
    let nonce = b64_bytes::<16>(m["nonce"].as_str().unwrap_or_default())?;
    Ok(poseidon2(&[
        tag("KEELSON_MANDATE"),
        user_key,
        integer(&range["max"]),
        Fr::from(u128::from(currency)),
        Fr::from(u128::from(mandate_category_mask(m)?)),
        root,
        integer(&m["exp"]),
        operator,
        Fr::from_be_bytes_reduce(&nonce),
        Fr::from_be_bytes_reduce(&salt),
    ]))
}
