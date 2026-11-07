//! Types that hold key material can be neither printed, serialized nor copied.

use std::fmt::{Debug, Display};

use keelson_tee::{Engine, Root, Signer};
use serde::Serialize;
use static_assertions::assert_not_impl_any;

assert_not_impl_any!(Root: Debug, Display, Serialize, Clone, Copy);
assert_not_impl_any!(Signer: Debug, Display, Serialize, Clone, Copy);
assert_not_impl_any!(Engine: Debug, Display, Serialize, Clone, Copy);

#[test]
fn key_material_cannot_be_formatted_serialized_or_cloned() {}
