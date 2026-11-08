// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title Sha384
/// @notice SHA-384 (FIPS 180-4 §6.5): the SHA-512 compression function with SHA-384's initial hash value, truncated
/// to 48 bytes. The EVM has no SHA-384 precompile.
library Sha384 {
    /// @notice The 48-byte SHA-384 digest of `data`.
    function hash(bytes memory data) internal pure returns (bytes memory digest) {
        assembly ("memory-safe") {
            function rotr(x, n) -> y {
                y := or(shr(n, x), and(shl(sub(64, n), x), 0xffffffffffffffff))
            }

            // FIPS 180-4 §6.4.2 on one 128-byte block at `blk`, with the state at `h`.
            function compress(blk, h, k, w) {
                let mask := 0xffffffffffffffff
                for { let t := 0 } lt(t, 16) { t := add(t, 1) } {
                    mstore(add(w, shl(5, t)), shr(192, mload(add(blk, shl(3, t)))))
                }
                for { let t := 16 } lt(t, 80) { t := add(t, 1) } {
                    let w2 := mload(add(w, shl(5, sub(t, 2))))
                    let w15 := mload(add(w, shl(5, sub(t, 15))))
                    let s1 := xor(xor(rotr(w2, 19), rotr(w2, 61)), shr(6, w2))
                    let s0 := xor(xor(rotr(w15, 1), rotr(w15, 8)), shr(7, w15))
                    mstore(
                        add(w, shl(5, t)),
                        and(
                            add(add(s1, mload(add(w, shl(5, sub(t, 7))))), add(s0, mload(add(w, shl(5, sub(t, 16)))))),
                            mask
                        )
                    )
                }
                let a := mload(h)
                let b := mload(add(h, 0x20))
                let c := mload(add(h, 0x40))
                let d := mload(add(h, 0x60))
                let e := mload(add(h, 0x80))
                let f := mload(add(h, 0xa0))
                let g := mload(add(h, 0xc0))
                let hh := mload(add(h, 0xe0))
                for { let t := 0 } lt(t, 80) { t := add(t, 1) } {
                    let t1 :=
                        add(
                            add(hh, xor(xor(rotr(e, 14), rotr(e, 18)), rotr(e, 41))),
                            add(xor(g, and(e, xor(f, g))), add(mload(add(k, shl(5, t))), mload(add(w, shl(5, t)))))
                        )
                    let t2 := add(xor(xor(rotr(a, 28), rotr(a, 34)), rotr(a, 39)), or(and(a, b), and(c, or(a, b))))
                    hh := g
                    g := f
                    f := e
                    e := and(add(d, t1), mask)
                    d := c
                    c := b
                    b := a
                    a := and(add(t1, t2), mask)
                }
                mstore(h, and(add(mload(h), a), mask))
                mstore(add(h, 0x20), and(add(mload(add(h, 0x20)), b), mask))
                mstore(add(h, 0x40), and(add(mload(add(h, 0x40)), c), mask))
                mstore(add(h, 0x60), and(add(mload(add(h, 0x60)), d), mask))
                mstore(add(h, 0x80), and(add(mload(add(h, 0x80)), e), mask))
                mstore(add(h, 0xa0), and(add(mload(add(h, 0xa0)), f), mask))
                mstore(add(h, 0xc0), and(add(mload(add(h, 0xc0)), g), mask))
                mstore(add(h, 0xe0), and(add(mload(add(h, 0xe0)), hh), mask))
            }

            digest := mload(0x40)
            mstore(0x40, add(digest, 0x60))

            // Scratch past the free memory pointer: round constants, message schedule, state, final blocks.
            let k := add(digest, 0x60)
            let w := add(k, 0xa00)
            let h := add(w, 0xa00)
            let tail := add(h, 0x100)

            // FIPS 180-4 §4.2.3: the first 64 bits of the fractional parts of the cube roots of the first 80 primes.
            mstore(add(k, 0x0), 0x428a2f98d728ae22)
            mstore(add(k, 0x20), 0x7137449123ef65cd)
            mstore(add(k, 0x40), 0xb5c0fbcfec4d3b2f)
            mstore(add(k, 0x60), 0xe9b5dba58189dbbc)
            mstore(add(k, 0x80), 0x3956c25bf348b538)
            mstore(add(k, 0xa0), 0x59f111f1b605d019)
            mstore(add(k, 0xc0), 0x923f82a4af194f9b)
            mstore(add(k, 0xe0), 0xab1c5ed5da6d8118)
            mstore(add(k, 0x100), 0xd807aa98a3030242)
            mstore(add(k, 0x120), 0x12835b0145706fbe)
            mstore(add(k, 0x140), 0x243185be4ee4b28c)
            mstore(add(k, 0x160), 0x550c7dc3d5ffb4e2)
            mstore(add(k, 0x180), 0x72be5d74f27b896f)
            mstore(add(k, 0x1a0), 0x80deb1fe3b1696b1)
            mstore(add(k, 0x1c0), 0x9bdc06a725c71235)
            mstore(add(k, 0x1e0), 0xc19bf174cf692694)
            mstore(add(k, 0x200), 0xe49b69c19ef14ad2)
            mstore(add(k, 0x220), 0xefbe4786384f25e3)
            mstore(add(k, 0x240), 0x0fc19dc68b8cd5b5)
            mstore(add(k, 0x260), 0x240ca1cc77ac9c65)
            mstore(add(k, 0x280), 0x2de92c6f592b0275)
            mstore(add(k, 0x2a0), 0x4a7484aa6ea6e483)
            mstore(add(k, 0x2c0), 0x5cb0a9dcbd41fbd4)
            mstore(add(k, 0x2e0), 0x76f988da831153b5)
            mstore(add(k, 0x300), 0x983e5152ee66dfab)
            mstore(add(k, 0x320), 0xa831c66d2db43210)
            mstore(add(k, 0x340), 0xb00327c898fb213f)
            mstore(add(k, 0x360), 0xbf597fc7beef0ee4)
            mstore(add(k, 0x380), 0xc6e00bf33da88fc2)
            mstore(add(k, 0x3a0), 0xd5a79147930aa725)
            mstore(add(k, 0x3c0), 0x06ca6351e003826f)
            mstore(add(k, 0x3e0), 0x142929670a0e6e70)
            mstore(add(k, 0x400), 0x27b70a8546d22ffc)
            mstore(add(k, 0x420), 0x2e1b21385c26c926)
            mstore(add(k, 0x440), 0x4d2c6dfc5ac42aed)
            mstore(add(k, 0x460), 0x53380d139d95b3df)
            mstore(add(k, 0x480), 0x650a73548baf63de)
            mstore(add(k, 0x4a0), 0x766a0abb3c77b2a8)
            mstore(add(k, 0x4c0), 0x81c2c92e47edaee6)
            mstore(add(k, 0x4e0), 0x92722c851482353b)
            mstore(add(k, 0x500), 0xa2bfe8a14cf10364)
            mstore(add(k, 0x520), 0xa81a664bbc423001)
            mstore(add(k, 0x540), 0xc24b8b70d0f89791)
            mstore(add(k, 0x560), 0xc76c51a30654be30)
            mstore(add(k, 0x580), 0xd192e819d6ef5218)
            mstore(add(k, 0x5a0), 0xd69906245565a910)
            mstore(add(k, 0x5c0), 0xf40e35855771202a)
            mstore(add(k, 0x5e0), 0x106aa07032bbd1b8)
            mstore(add(k, 0x600), 0x19a4c116b8d2d0c8)
            mstore(add(k, 0x620), 0x1e376c085141ab53)
            mstore(add(k, 0x640), 0x2748774cdf8eeb99)
            mstore(add(k, 0x660), 0x34b0bcb5e19b48a8)
            mstore(add(k, 0x680), 0x391c0cb3c5c95a63)
            mstore(add(k, 0x6a0), 0x4ed8aa4ae3418acb)
            mstore(add(k, 0x6c0), 0x5b9cca4f7763e373)
            mstore(add(k, 0x6e0), 0x682e6ff3d6b2b8a3)
            mstore(add(k, 0x700), 0x748f82ee5defb2fc)
            mstore(add(k, 0x720), 0x78a5636f43172f60)
            mstore(add(k, 0x740), 0x84c87814a1f0ab72)
            mstore(add(k, 0x760), 0x8cc702081a6439ec)
            mstore(add(k, 0x780), 0x90befffa23631e28)
            mstore(add(k, 0x7a0), 0xa4506cebde82bde9)
            mstore(add(k, 0x7c0), 0xbef9a3f7b2c67915)
            mstore(add(k, 0x7e0), 0xc67178f2e372532b)
            mstore(add(k, 0x800), 0xca273eceea26619c)
            mstore(add(k, 0x820), 0xd186b8c721c0c207)
            mstore(add(k, 0x840), 0xeada7dd6cde0eb1e)
            mstore(add(k, 0x860), 0xf57d4f7fee6ed178)
            mstore(add(k, 0x880), 0x06f067aa72176fba)
            mstore(add(k, 0x8a0), 0x0a637dc5a2c898a6)
            mstore(add(k, 0x8c0), 0x113f9804bef90dae)
            mstore(add(k, 0x8e0), 0x1b710b35131c471b)
            mstore(add(k, 0x900), 0x28db77f523047d84)
            mstore(add(k, 0x920), 0x32caab7b40c72493)
            mstore(add(k, 0x940), 0x3c9ebe0a15c9bebc)
            mstore(add(k, 0x960), 0x431d67c49c100d4c)
            mstore(add(k, 0x980), 0x4cc5d4becb3e42b6)
            mstore(add(k, 0x9a0), 0x597f299cfc657e2a)
            mstore(add(k, 0x9c0), 0x5fcb6fab3ad6faec)
            mstore(add(k, 0x9e0), 0x6c44198c4a475817)

            // FIPS 180-4 §5.3.4.
            mstore(h, 0xcbbb9d5dc1059ed8)
            mstore(add(h, 0x20), 0x629a292a367cd507)
            mstore(add(h, 0x40), 0x9159015a3070dd17)
            mstore(add(h, 0x60), 0x152fecd8f70e5939)
            mstore(add(h, 0x80), 0x67332667ffc00b31)
            mstore(add(h, 0xa0), 0x8eb44a8768581511)
            mstore(add(h, 0xc0), 0xdb0c2e0d64f98fa7)
            mstore(add(h, 0xe0), 0x47b5481dbefa4fa4)

            let len := mload(data)
            let src := add(data, 0x20)
            let full := shl(7, shr(7, len))
            for { let i := 0 } lt(i, full) { i := add(i, 0x80) } { compress(add(src, i), h, k, w) }

            // FIPS 180-4 §5.1.2: 0x80, zeros, then the length in bits as a 128-bit big-endian integer.
            let rem := sub(len, full)
            let end := 0x80
            if gt(add(rem, 17), 0x80) { end := 0x100 }
            for { let i := 0 } lt(i, end) { i := add(i, 0x20) } { mstore(add(tail, i), 0) }
            mstore(add(tail, sub(end, 0x20)), shl(3, len))
            mcopy(tail, add(src, full), rem)
            mstore8(add(tail, rem), 0x80)
            compress(tail, h, k, w)
            if eq(end, 0x100) { compress(add(tail, 0x80), h, k, w) }

            mstore(digest, 48)
            mstore(
                add(digest, 0x20),
                or(
                    or(shl(192, mload(h)), shl(128, mload(add(h, 0x20)))),
                    or(shl(64, mload(add(h, 0x40))), mload(add(h, 0x60)))
                )
            )
            mstore(add(digest, 0x40), or(shl(192, mload(add(h, 0x80))), shl(128, mload(add(h, 0xa0)))))
        }
    }
}
