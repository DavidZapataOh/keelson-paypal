// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IEd25519Verifier} from "./interfaces/IEd25519Verifier.sol";
import {ILogBond} from "./interfaces/ILogBond.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

/// @title LogBond
/// @notice A bond on one transparency log's Ed25519 key. Two checkpoints of the log that both carry a valid signature
/// of the key and state different roots for the same size are proof that the log showed two histories; they slash the
/// whole bond, once: a bounty to whoever submits them, the rest to the beneficiary. The notes are c2sp.org/tlog-checkpoint
/// signed notes (c2sp.org/signed-note).
/// @dev No admin and no upgrade path. The owner can only withdraw, after `withdrawalDelay` and within
/// `completionWindow`, and what is waiting to leave stays in the bond until it does. Whoever holds the key can always
/// prove an equivocation of its own, so the bounty is what it can take back that way.
contract LogBond is ILogBond, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @dev As `CheckpointAnchor` caps signed notes.
    uint256 internal constant MAX_NOTE = 8192;
    /// @dev The Go `note` package's limit on signature lines.
    uint256 internal constant MAX_SIGNATURES = 100;
    /// @dev `"— "`, the start of every signature line (an em dash, U+2014, and a space).
    bytes4 internal constant SIG_PREFIX = 0xe2809420;
    /// @dev A base64 Ed25519 signature line payload: 4-byte key id and 64-byte signature.
    uint256 internal constant SIG_BASE64 = 92;
    /// @dev A base64 SHA-256 root.
    uint256 internal constant ROOT_BASE64 = 44;
    uint16 internal constant MAX_BOUNTY_BPS = 5000;
    /// @dev ArbSys, the Arbitrum system precompile.
    address internal constant ARB_SYS = address(100);

    IERC20 public immutable token;
    IEd25519Verifier public immutable verifier;
    address public immutable owner;
    bytes32 public immutable origin;
    bytes32 public immutable key;
    uint40 public immutable withdrawalDelay;
    uint40 public immutable completionWindow;
    address public immutable beneficiary;
    uint16 public immutable bountyBps;

    Withdrawal internal _withdrawal;
    Equivocation internal _equivocation;

    struct Opened {
        uint64 size;
        bytes32 root;
    }

    constructor(
        IERC20 token_,
        IEd25519Verifier verifier_,
        // forge-lint: disable-next-line(missing-zero-check)
        address owner_,
        bytes32 origin_,
        bytes32 key_,
        uint40 withdrawalDelay_,
        uint40 completionWindow_,
        address beneficiary_,
        uint16 bountyBps_
    ) {
        // At most half: whoever holds the key can prove its own equivocation and take the bounty back.
        if (bountyBps_ > MAX_BOUNTY_BPS) revert InvalidBounty();
        if (beneficiary_ == address(0)) revert InvalidBeneficiary();
        token = token_;
        verifier = verifier_;
        owner = owner_;
        origin = origin_;
        key = key_;
        withdrawalDelay = withdrawalDelay_;
        completionWindow = completionWindow_;
        beneficiary = beneficiary_;
        bountyBps = bountyBps_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @inheritdoc ILogBond
    function withdrawal() external view returns (Withdrawal memory) {
        return _withdrawal;
    }

    /// @inheritdoc ILogBond
    function equivocation() external view returns (Equivocation memory) {
        return _equivocation;
    }

    /// @inheritdoc ILogBond
    function slashed() public view returns (bool) {
        return _equivocation.prover != address(0);
    }

    /// @inheritdoc ILogBond
    function checkpoint(bytes calldata note) external view returns (uint64 size, bytes32 root) {
        Opened memory c = _open(note, 0);
        return (c.size, c.root);
    }

    /// @inheritdoc ILogBond
    function deposit(uint256 amount) external nonReentrant {
        if (slashed()) revert AlreadySlashed();
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @inheritdoc ILogBond
    function requestWithdrawal(uint128 amount, address to) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        uint40 unlockAt = (block.timestamp + withdrawalDelay).toUint40();
        _withdrawal = Withdrawal({amount: amount, unlockAt: unlockAt, to: to});
        emit WithdrawalRequested(to, amount, unlockAt);
    }

    /// @inheritdoc ILogBond
    function completeWithdrawal() external nonReentrant onlyOwner {
        Withdrawal memory w = _withdrawal;
        if (w.amount == 0 || block.timestamp < w.unlockAt || block.timestamp > w.unlockAt + completionWindow) {
            revert NotReady();
        }
        delete _withdrawal;
        uint256 balance = token.balanceOf(address(this));
        uint256 amount = w.amount < balance ? w.amount : balance;
        emit WithdrawalCompleted(w.to, amount);
        token.safeTransfer(w.to, amount);
    }

    /// @inheritdoc ILogBond
    function proveEquivocation(bytes calldata noteA, bytes calldata noteB) external nonReentrant {
        if (slashed()) revert AlreadySlashed();
        Opened memory a = _open(noteA, 0);
        Opened memory b = _open(noteB, 1);
        if (a.size != b.size || a.root == b.root) revert NotEquivocation();

        uint256 amount = token.balanceOf(address(this));
        uint256 bounty = amount * bountyBps / 10_000;
        _equivocation = Equivocation({
            prover: msg.sender,
            amount: amount.toUint128(),
            bounty: bounty.toUint128(),
            provenAt: block.timestamp.toUint40(),
            size: a.size,
            l2Block: _l2Block(),
            rootA: a.root,
            rootB: b.root
        });
        delete _withdrawal;
        // The calls before are static calls to the verifier and the token.
        // forge-lint: disable-next-line(reentrancy-events)
        emit EquivocationProven(msg.sender, a.size, a.root, b.root, amount, bounty, keccak256(noteA), keccak256(noteB));
        if (bounty > 0) token.safeTransfer(msg.sender, bounty);
        // A beneficiary the token refuses (frozen) must not make the bond unslashable: its share then
        // stays here, and `release` sends it once the token accepts it.
        // slither-disable-next-line unused-return
        if (amount > bounty) token.trySafeTransfer(beneficiary, amount - bounty);
    }

    /// @inheritdoc ILogBond
    function release() external nonReentrant {
        if (!slashed()) revert NotReady();
        token.safeTransfer(beneficiary, token.balanceOf(address(this)));
    }

    /// @dev Opens `note` as a checkpoint of the origin with a valid signature of the key: the text is the origin line,
    /// the decimal size, the canonical base64 root and any extension lines; signature lines of other keys are skipped.
    function _open(bytes calldata note, uint8 which) internal view returns (Opened memory c) {
        if (note.length > MAX_NOTE) revert InvalidNote(which);
        uint256 end = _find(note, 0, hex"0a0a");
        if (end == type(uint256).max || note[note.length - 1] != 0x0a) revert InvalidNote(which);
        bytes calldata text = note[:end + 1];

        uint256 nl = _find(text, 0, hex"0a");
        bytes calldata name = text[:nl];
        if (keccak256(name) != origin) revert InvalidNote(which);
        uint256 next = _find(text, nl + 1, hex"0a");
        if (next == type(uint256).max) revert InvalidNote(which);
        bool ok;
        (c.size, ok) = _decimal(text[nl + 1:next]);
        if (!ok) revert InvalidNote(which);
        nl = next;
        next = _find(text, nl + 1, hex"0a");
        if (next == type(uint256).max || next - nl - 1 != ROOT_BASE64) revert InvalidNote(which);
        bytes calldata encodedRoot = text[nl + 1:next];
        bytes memory root = Base64.decode(string(encodedRoot));
        if (root.length != 32 || keccak256(bytes(Base64.encode(root))) != keccak256(encodedRoot)) {
            revert InvalidNote(which);
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        c.root = bytes32(root);

        if (!_signed(note[end + 2:], name, text)) revert InvalidNote(which);
    }

    /// @dev Whether a signature line named `name` carries a valid signature of the key over `text`.
    function _signed(bytes calldata sigs, bytes calldata name, bytes calldata text) internal view returns (bool) {
        uint256 start = 0;
        for (uint256 i = 0; i < MAX_SIGNATURES && start < sigs.length; ++i) {
            uint256 nl = _find(sigs, start, hex"0a");
            bytes calldata line = sigs[start:nl];
            start = nl + 1;
            uint256 payload = 4 + name.length + 1;
            if (
                line.length != payload + SIG_BASE64 || bytes4(line[:4]) != SIG_PREFIX
                    || keccak256(line[4:payload - 1]) != keccak256(name) || line[payload - 1] != 0x20
            ) continue;
            bytes memory raw = Base64.decode(string(line[payload:]));
            if (raw.length != 68) continue;
            bytes memory signature = new bytes(64);
            for (uint256 j = 0; j < 64; ++j) {
                signature[j] = raw[j + 4];
            }
            // At most one call per line of the origin's name; the verifier is immutable and stateless.
            // forge-lint: disable-next-line(calls-loop)
            if (verifier.verify(key, text, signature)) return true;
        }
        return false;
    }

    /// @dev The index of the first `needle` in `data` at or after `from`, or `type(uint256).max`.
    function _find(bytes calldata data, uint256 from, bytes memory needle) internal pure returns (uint256) {
        uint256 n = needle.length;
        for (uint256 i = from; i + n <= data.length; ++i) {
            if (data[i] == needle[0] && (n == 1 || data[i + 1] == needle[1])) return i;
        }
        return type(uint256).max;
    }

    /// @dev A decimal `uint64` with no sign and no leading zeros.
    function _decimal(bytes calldata s) internal pure returns (uint64, bool) {
        if (s.length == 0 || s.length > 20 || (s.length > 1 && s[0] == "0")) return (0, false);
        uint256 v = 0;
        for (uint256 i = 0; i < s.length; ++i) {
            uint8 digit = uint8(s[i]);
            if (digit < 0x30 || digit > 0x39) return (0, false);
            v = v * 10 + (digit - 0x30);
        }
        if (v > type(uint64).max) return (0, false);
        // forge-lint: disable-next-line(unsafe-typecast)
        return (uint64(v), true);
    }

    function _l2Block() internal view returns (uint64) {
        (bool ok, bytes memory ret) = ARB_SYS.staticcall(abi.encodeCall(IArbSys.arbBlockNumber, ()));
        return ok && ret.length == 32 ? abi.decode(ret, (uint256)).toUint64() : 0;
    }
}
