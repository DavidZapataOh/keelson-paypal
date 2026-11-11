// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IEd25519Verifier} from "./IEd25519Verifier.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ILogBond
/// @notice A bond on one transparency log's key: whoever presents two checkpoints of the log, both signed by its
/// Ed25519 key, that state different roots for the same tree size takes the whole bond. The log showed two histories.
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
        uint128 amount;
        uint40 provenAt;
        uint64 size;
        uint64 l2Block;
        bytes32 rootA;
        bytes32 rootB;
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
        bytes32 noteHashA,
        bytes32 noteHashB
    );

    error NotOwner();
    /// @notice Note `which` (0 or 1) is not a checkpoint of the origin signed by its key.
    error InvalidNote(uint8 which);
    /// @notice The two checkpoints do not state different roots for the same size.
    error NotEquivocation();
    /// @notice The bond was already paid out for an equivocation.
    error AlreadySlashed();
    error ZeroAmount();
    /// @notice No withdrawal is pending, or it has not unlocked yet.
    error NotReady();

    function token() external view returns (IERC20);
    function verifier() external view returns (IEd25519Verifier);
    function owner() external view returns (address);
    /// @notice `keccak256` of the log's origin line, which is also its key's note name.
    function origin() external view returns (bytes32);
    /// @notice The log's Ed25519 public key, as RFC 8032 encodes it.
    function key() external view returns (bytes32);
    function withdrawalDelay() external view returns (uint40);
    function withdrawal() external view returns (Withdrawal memory);
    function equivocation() external view returns (Equivocation memory);
    function slashed() external view returns (bool);

    /// @notice The size and root of `note`, a checkpoint of the origin signed by the key; reverts with
    /// `InvalidNote(0)` otherwise. A bond whose key opens a checkpoint the log published pins the right key.
    function checkpoint(bytes calldata note) external view returns (uint64 size, bytes32 root);

    /// @notice Adds `amount` of the token to the bond from the caller.
    function deposit(uint256 amount) external;

    /// @notice Starts withdrawing `amount` to `to` once `withdrawalDelay` has passed, replacing any pending request.
    /// Until it completes the amount stays in the bond and is paid out by an equivocation. Owner only.
    function requestWithdrawal(uint128 amount, address to) external;

    /// @notice Pays the pending withdrawal once unlocked, capped at what the bond holds. Owner only.
    function completeWithdrawal() external;

    /// @notice Pays the whole bond to the caller if `noteA` and `noteB` are c2sp.org/tlog-checkpoint signed notes of the
    /// origin, both signed by its key, stating different roots for the same size.
    function proveEquivocation(bytes calldata noteA, bytes calldata noteB) external;
}
