// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IEd25519Verifier} from "../interfaces/IEd25519Verifier.sol";
import {SCL_EIP6565} from "crypto-lib/lib/libSCL_EIP6565.sol";
import {SCL_sha512} from "crypto-lib/hash/SCL_sha512.sol";
import {d, p, pMINUS_1, pp3div8, sqrtm1} from "crypto-lib/fields/SCL_wei25519.sol";
import {ModInv} from "crypto-lib/modular/SCL_modular.sol";

/// @title Ed25519Verifier
/// @notice Ed25519 verification in EVM bytecode, with the Smoo.th CryptoLib (SCL) implementation of EIP-6565, audited
/// by Veridise. It checks `[S]B = R + [k]A'` with `S < L`, as RFC 8032 §5.1.7 allows. Stateless, no owner.
contract Ed25519Verifier is IEd25519Verifier {
    /// @dev The ModExp precompile (EIP-198).
    address internal constant MODEXP = address(0x05);

    /// @inheritdoc IEd25519Verifier
    function verify(bytes32 key, bytes calldata message, bytes calldata signature) external view returns (bool) {
        if (signature.length != 64) return false;
        (uint256 x, uint256 y) = _decompress(key);
        if (x == 0) return false;
        uint256[5] memory extKey;
        (extKey[0], extKey[1]) = SCL_EIP6565.Edwards2WeierStrass(x, y);
        extKey[4] = uint256(key);
        return SCL_EIP6565.Verify_LE(
            string(message), uint256(bytes32(signature[:32])), uint256(bytes32(signature[32:])), extKey
        );
    }

    /// @dev RFC 8032 §5.1.3. Returns `x = 0` for an encoding that is not a point, and for the two points with `x = 0`,
    /// which `verify` refuses as keys.
    function _decompress(bytes32 key) internal view returns (uint256 x, uint256 y) {
        uint256 encoded = SCL_sha512.Swap256(uint256(key));
        uint256 sign = encoded >> 255;
        y = encoded & ((1 << 255) - 1);
        if (y >= p) return (0, y);
        uint256 y2 = mulmod(y, y, p);
        uint256 x2 = mulmod(addmod(y2, pMINUS_1, p), ModInv(addmod(mulmod(d, y2, p), 1, p), p), p);
        if (x2 == 0) return (0, y);
        // p = 5 (mod 8): a candidate root is x2^((p+3)/8), or that times sqrt(-1).
        x = _modexp(x2, pp3div8);
        if (mulmod(x, x, p) != x2) x = mulmod(x, sqrtm1, p);
        if (mulmod(x, x, p) != x2) return (0, y);
        if (x & 1 != sign) x = p - x;
    }

    function _modexp(uint256 base, uint256 exponent) internal view returns (uint256 result) {
        (bool ok, bytes memory out) = MODEXP.staticcall(abi.encode(32, 32, 32, base, exponent, p));
        require(ok);
        result = abi.decode(out, (uint256));
    }
}
