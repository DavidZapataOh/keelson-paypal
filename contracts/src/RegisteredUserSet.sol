// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";

/// @notice bb's UltraHonk verifier of the C3 `anonymous_mandate` circuit.
interface IAnonymousMandateVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/// @title RegisteredUserSet
/// @notice The roots Keelson's registered-user tree has had, as Keelson published them, and the check a merchant runs
/// on a C3 proof: a passkey in a published tree signed the mandate `mandateHash`, whose commitment `cm` names it, for
/// the RP ID `keelson.finance`. Which passkey stays private.
/// @dev The tree is the Poseidon2 Merkle tree of every registered passkey's `user_key_hash`, in registration order.
/// The record is append-only: a published root is never changed or removed, so a proof made under it keeps verifying,
/// unless the Guardian revokes it (a root the relayer's key published without Keelson). `publish` is restricted by the
/// AccessManager to `PUBLISHER_ROLE`, held by Keelson's relayer, and `revoke` to `GUARDIAN_ROLE`.
contract RegisteredUserSet is AccessManaged {
    /// @notice When a root was published, how many users its tree held, as the relayer states it, and when it was
    /// revoked, 0 while it stands.
    struct Root {
        uint64 publishedAt;
        uint32 size;
        uint64 revokedAt;
    }

    /// @dev The BN254 scalar field modulus: every public input of the proof is below it.
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// @dev The circuit's tree has depth 20.
    uint256 internal constant MAX_SIZE = 1 << 20;
    /// @notice `sha256("keelson.finance")`, the RP ID every Keelson passkey is scoped to; it is below `R`.
    bytes32 public constant RP_ID_HASH = 0x1071caa839ec25d37b233c1d4b37fd3a9d1b0a09830e137e452105c07d6fc4f7;

    IAnonymousMandateVerifier public immutable verifier;

    mapping(bytes32 root => Root) public roots;

    event RootPublished(bytes32 indexed root, uint32 size);
    event RootRevoked(bytes32 indexed root);

    error InvalidRoot();
    error UnknownRoot();

    constructor(address authority, IAnonymousMandateVerifier verifier_) AccessManaged(authority) {
        verifier = verifier_;
    }

    /// @notice Publishes `root`, the tree's root when it held `size` users. A root already published is left as it
    /// was, so a retried transaction does nothing.
    function publish(bytes32 root, uint32 size) external restricted {
        if (root == bytes32(0) || uint256(root) >= R || size == 0 || size > MAX_SIZE) revert InvalidRoot();
        if (roots[root].publishedAt != 0) return;
        // casting to 'uint64' is safe because timestamps fit it for billions of years
        // forge-lint: disable-next-line(unsafe-typecast)
        roots[root] = Root(uint64(block.timestamp), size, 0);
        // The only external call is `restricted`'s to the AccessManager, a Keelson contract.
        // forge-lint: disable-next-line(reentrancy-events)
        emit RootPublished(root, size);
    }

    /// @notice Revokes a published `root`: no proof under it verifies again. Revoking it again does nothing.
    function revoke(bytes32 root) external restricted {
        Root storage r = roots[root];
        if (r.publishedAt == 0) revert UnknownRoot();
        if (r.revokedAt != 0) return;
        // casting to 'uint64' is safe because timestamps fit it for billions of years
        // forge-lint: disable-next-line(unsafe-typecast)
        r.revokedAt = uint64(block.timestamp);
        // forge-lint: disable-next-line(reentrancy-events)
        emit RootRevoked(root);
    }

    /// @notice Whether `proof` shows that a user of the published tree `root` signed the mandate whose passkey
    /// challenge is `mandateHash` and whose commitment is `cm`, as a countersign names both. False for an unpublished
    /// or revoked root and for any proof the verifier rejects, never a revert.
    /// @dev `mandateHash` enters the proof modulo the field, so `mandateHash + k·r` verifies too: pass the `M` the
    /// countersign names and never use this argument as an identifier.
    function verify(bytes calldata proof, bytes32 cm, bytes32 mandateHash, bytes32 root) external view returns (bool) {
        Root memory r = roots[root];
        // Zero means unset, not a time compared against the clock.
        // slither-disable-next-line incorrect-equality
        if (r.publishedAt == 0 || r.revokedAt != 0) return false;
        bytes32[] memory inputs = new bytes32[](4);
        inputs[0] = cm;
        inputs[1] = bytes32(uint256(mandateHash) % R);
        inputs[2] = root;
        inputs[3] = RP_ID_HASH;
        // bb's verifier reverts on most proofs it rejects.
        try verifier.verify(proof, inputs) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }
}
