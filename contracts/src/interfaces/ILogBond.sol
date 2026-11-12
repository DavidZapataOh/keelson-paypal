// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IEd25519Verifier} from "./IEd25519Verifier.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ILogBond
/// @notice A bond on one transparency log's key: two checkpoints of the log, both signed by its Ed25519 key, that state
/// different roots for the same tree size, or hold different leaves at one index at any two sizes, slash the whole bond.
/// The log showed two histories. A bounty goes to whoever
/// proves it and the rest to a beneficiary fixed at construction, so the key's holder gains nothing by proving it.
interface ILogBond {
    struct Withdrawal {
        uint128 amount;
        uint40 unlockAt;
        address to;
    }

    /// @notice The proven equivocation. `l2Block` is the Arbitrum block of the slash (`ArbSys.arbBlockNumber`), so its
    /// transaction can be found from its logs; zero off Arbitrum.
    struct Equivocation {
        address prover;
        /// @notice The whole bond, of which `bounty` went to the prover and the rest to the beneficiary.
        uint128 amount;
        uint128 bounty;
        uint40 provenAt;
        uint64 size;
        uint64 l2Block;
        bytes32 rootA;
        bytes32 rootB;
    }

    /// @notice An RFC 6962 inclusion proof of the leaf hash `leaf`.
    struct Inclusion {
        bytes32 leaf;
        bytes32[] proof;
    }

    event Deposited(address indexed from, uint256 amount);
    event WithdrawalRequested(address indexed to, uint256 amount, uint40 unlockAt);
    event WithdrawalCompleted(address indexed to, uint256 amount);
    /// @param noteHashA `keccak256` of the first note, which the transaction's calldata carries; likewise `noteHashB`.
    event EquivocationProven(
        address indexed prover,
        uint64 size,
        bytes32 rootA,
        bytes32 rootB,
        uint256 amount,
        uint256 bounty,
        bytes32 noteHashA,
        bytes32 noteHashB
    );

    error NotOwner();
    /// @notice The bounty is more than half the bond.
    error InvalidBounty();
    /// @notice The beneficiary is the zero address.
    error InvalidBeneficiary();
    /// @notice Note `which` (0 or 1) is not a checkpoint of the origin signed by its key.
    error InvalidNote(uint8 which);
    /// @notice The two checkpoints do not state different roots for the same size.
    error NotEquivocation();
    /// @notice The two checkpoints do not provably hold different leaves at the index both cover.
    error NotInconsistent();
    /// @notice The bond was already paid out for an equivocation.
    error AlreadySlashed();
    error ZeroAmount();
    /// @notice No withdrawal is pending, it has not unlocked yet, or its completion window has passed.
    error NotReady();

    function token() external view returns (IERC20);
    function verifier() external view returns (IEd25519Verifier);
    function owner() external view returns (address);
    /// @notice `keccak256` of the log's origin line, which is also its key's note name.
    function origin() external view returns (bytes32);
    /// @notice The log's Ed25519 public key, as RFC 8032 encodes it.
    function key() external view returns (bytes32);
    function withdrawalDelay() external view returns (uint40);
    /// @notice How long an unlocked withdrawal can be completed; after it, the request lapses.
    function completionWindow() external view returns (uint40);
    /// @notice Who receives the slashed bond less the bounty.
    function beneficiary() external view returns (address);
    /// @notice The prover's share of a slash, in basis points.
    function bountyBps() external view returns (uint16);
    function withdrawal() external view returns (Withdrawal memory);
    function equivocation() external view returns (Equivocation memory);
    function slashed() external view returns (bool);

    /// @notice The size and root of `note`, a checkpoint of the origin signed by the key; reverts with
    /// `InvalidNote(0)` otherwise. A bond whose key opens a checkpoint the log published pins the right key.
    function checkpoint(bytes calldata note) external view returns (uint64 size, bytes32 root);

    /// @notice Adds `amount` of the token to the bond from the caller.
    function deposit(uint256 amount) external;

    /// @notice Starts withdrawing `amount` to `to` once `withdrawalDelay` has passed, replacing any pending request; it
    /// must then complete within `completionWindow`. Until it completes the amount stays in the bond and is slashed by an
    /// equivocation. Owner only.
    function requestWithdrawal(uint128 amount, address to) external;

    /// @notice Pays the pending withdrawal once unlocked, capped at what the bond holds. Owner only.
    function completeWithdrawal() external;

    /// @notice After a slash, sends what the bond still holds to the beneficiary: its share, when the token refused it
    /// at the slash. Anyone may call it.
    function release() external;

    /// @notice Slashes the whole bond if `noteA` and `noteB` are c2sp.org/tlog-checkpoint signed notes of the origin, both
    /// signed by its key, stating different roots for the same size: `bountyBps` of it to the caller, the rest to the
    /// beneficiary.
    function proveEquivocation(bytes calldata noteA, bytes calldata noteB) external;

    /// @notice Slashes the whole bond, as `proveEquivocation` does, if `noteA` and `noteB` are signed checkpoints of the
    /// origin, of any sizes, whose trees hold different leaves at `index`: `a` proves one leaf at `index` in `noteA`'s
    /// tree, `b` a different one in `noteB`'s, and `index` is below both sizes. No append-only log can sign both,
    /// whatever the sizes. The recorded size is the smaller one.
    function proveInconsistency(
        bytes calldata noteA,
        bytes calldata noteB,
        uint64 index,
        Inclusion calldata a,
        Inclusion calldata b
    ) external;
}
