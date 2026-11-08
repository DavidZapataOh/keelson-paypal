// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ICheckpointAnchor} from "./interfaces/ICheckpointAnchor.sol";
import {IERC8004Identity} from "./interfaces/IERC8004Identity.sol";
import {IKeelsonBondVault} from "./interfaces/IKeelsonBondVault.sol";
import {IPYUSD} from "./interfaces/IPYUSD.sol";
import {IVerdictVerifier} from "./interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "./libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "./libraries/PasskeyAssertion.sol";
import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title KeelsonBondVault
/// @notice Each operator's PYUSD bond, indexed by its ERC-8004 `agentId`, and the coverage it backs. Deposits are gasless
/// for the depositor (EIP-3009 or ERC-2612, submitted by anyone). Coverage is locked only for a purchase the user approved
/// with a passkey, the operator signed and both TEE legs countersigned. Funds leave only after every window in which a
/// claim may still arrive. Not upgradeable.
/// @dev Operators, owners and merchants sign under this contract's EIP-712 domain `{Keelson, 1, chainId, this}`; the
/// TEE legs sign under the `VerdictVerifier`'s.
contract KeelsonBondVault is IKeelsonBondVault, AccessManaged, EIP712, Nonces, ReentrancyGuardTransient, Pausable {
    using SafeERC20 for IPYUSD;
    using SafeCast for uint256;

    /// @notice PYUSD base units (6 decimals) per US cent, the unit of `Countersign.amount`.
    uint256 public constant PYUSD_PER_MINOR = 10_000;
    /// @notice ISO 4217 numeric code of USD.
    uint16 public constant USD = 840;
    /// @notice Minimum time a coverage countersigned by the TDX leg alone stays locked.
    uint40 public constant DEGRADED_WINDOW = 72 hours;
    uint8 internal constant ALLOW = 1;
    uint256 internal constant SIGNATURE_LENGTH = 65;

    IPYUSD public immutable pyusd;
    IVerdictVerifier public immutable verifier;
    ICheckpointAnchor public immutable anchor;
    IERC8004Identity public immutable identity;
    /// @notice The `KeelsonReserve`, which receives every premium.
    address public immutable reserve;
    /// @notice `keccak256` of the origin of the log whose anchored checkpoints batches name.
    bytes32 public immutable logOrigin;
    /// @notice `sha256` of the RP ID users' passkeys are registered for.
    bytes32 public immutable rpIdHash;

    Params internal _params;
    mapping(uint256 agentId => Bond) internal _bonds;
    mapping(bytes32 coverageId => CoverageState) internal _coverages;
    /// @notice EIP-712 struct hash of each locked `Coverage`, against which a claim's calldata is checked.
    mapping(bytes32 coverageId => bytes32) public coverageHash;
    /// @notice Slashes queued and not yet executed or vetoed, per agent; written by slashing.
    mapping(uint256 agentId => uint256) public pendingSlashes;
    /// @notice Amount slashed from each coverage; written by slashing.
    mapping(bytes32 coverageId => uint96) public slashed;
    mapping(bytes32 batchId => BatchState) internal _batches;
    mapping(bytes32 batchId => bytes32) public batchRoot;
    mapping(bytes32 batchId => uint128) public batchSlashed;
    mapping(uint256 id => Withdrawal) internal _withdrawals;
    uint256 public withdrawalCount;
    mapping(address merchant => address) public payoutAddress;

    constructor(
        IPYUSD pyusd_,
        IVerdictVerifier verifier_,
        ICheckpointAnchor anchor_,
        IERC8004Identity identity_,
        // forge-lint: disable-next-line(missing-zero-check)
        address reserve_,
        bytes32 logOrigin_,
        bytes32 rpIdHash_,
        address authority,
        Params memory params_
    ) AccessManaged(authority) EIP712("Keelson", "1") {
        pyusd = pyusd_;
        verifier = verifier_;
        anchor = anchor_;
        identity = identity_;
        reserve = reserve_;
        logOrigin = logOrigin_;
        rpIdHash = rpIdHash_;
        _setParams(params_);
    }

    /// @inheritdoc IKeelsonBondVault
    /// @dev The EIP-3009 nonce is `keccak256(abi.encode(agentId, salt))`, so the authorization credits only `agentId`.
    function depositWithAuthorization(
        uint256 agentId,
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        bytes calldata signature
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 before = pyusd.balanceOf(address(this));
        pyusd.receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, keccak256(abi.encode(agentId, salt)), signature
        );
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (pyusd.balanceOf(address(this)) - before != amount) revert AuthorizationNotUsed();
        _credit(agentId, from, amount);
    }

    /// @inheritdoc IKeelsonBondVault
    /// @dev A permit already submitted by someone else leaves the allowance, so its failure is ignored (OpenZeppelin's
    /// guidance on permit front-running); only the agent's own authority can be debited.
    function depositWithPermit(
        uint256 agentId,
        address owner,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (owner == address(0) || (owner != identity.ownerOf(agentId) && owner != identity.getAgentWallet(agentId))) {
            revert NotAgentAuthority();
        }
        try pyusd.permit(owner, address(this), amount, deadline, signature) {} catch {}
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        pyusd.safeTransferFrom(owner, address(this), amount);
        _credit(agentId, owner, amount);
    }

    /// @inheritdoc IKeelsonBondVault
    function lockCoverage(
        KeelsonTypes.Coverage calldata c,
        KeelsonTypes.Countersign calldata cs,
        bytes32 hSd,
        PasskeyAssertion.Assertion calldata userAuth,
        bytes32 qx,
        bytes32 qy,
        bytes calldata operatorSig,
        bytes calldata countersigs
    ) external nonReentrant whenNotPaused {
        if (_coverages[c.coverageId].status != Status.None) revert CoverageExists();
        if (
            cs.requestId != c.coverageId || cs.agentId != c.agentId || cs.decision != ALLOW || cs.currency != USD
                || uint256(cs.amount) * PYUSD_PER_MINOR != c.amount || cs.mandateHash != c.mandateHash
                || c.premium > c.amount
        ) revert CountersignMismatch();
        if (block.timestamp > cs.expiresAt || c.expiresAt <= block.timestamp) revert Expired();
        Params memory p = _params;
        if (c.expiresAt < uint256(cs.issuedAt) + p.disputeWindow) revert WindowTooShort();
        if (
            PasskeyAssertion.mandateChallenge(hSd, cs.mandateCommitment) != cs.mandateHash
                || !PasskeyAssertion.verify(cs.mandateHash, userAuth, rpIdHash, qx, qy)
        ) revert InvalidUserAssertion();
        bytes32 structHash = KeelsonTypes.hash(c);
        if (_authority(c.agentId, _hashTypedDataV4(structHash), operatorSig) == address(0)) {
            revert InvalidOperatorSignature();
        }
        bytes32 digest = verifier.hashTypedData(KeelsonTypes.hash(cs));
        bool degraded = countersigs.length == SIGNATURE_LENGTH;
        if (!(countersigs.length == 2 * SIGNATURE_LENGTH
                    ? verifier.verify2of2(digest, countersigs)
                    : degraded && verifier.verifyDegraded(digest, countersigs))) revert InvalidCountersignature();

        Bond storage bond = _bonds[c.agentId];
        uint256 debit = uint256(c.amount) + c.premium;
        if (bond.free < debit) revert InsufficientBond();
        // forge-lint: disable-next-line(unsafe-typecast)
        bond.free -= uint128(debit);
        bond.locked += c.amount;

        uint256 until = uint256(c.expiresAt) + p.grace;
        if (degraded && until < block.timestamp + DEGRADED_WINDOW) until = block.timestamp + DEGRADED_WINDOW;
        uint40 releaseAfter = until.toUint40();
        _coverages[c.coverageId] = CoverageState({
            amount: c.amount,
            agentId: c.agentId.toUint64(),
            releaseAfter: releaseAfter,
            status: Status.Active,
            degraded: degraded,
            pendingSlashes: 0
        });
        coverageHash[c.coverageId] = structHash;
        if (c.premium != 0) pyusd.safeTransfer(reserve, c.premium);

        // forge-lint: disable-start(reentrancy-events)
        emit CoverageLocked(
            c.coverageId,
            c.agentId,
            c.merchant,
            c.amount,
            c.premium,
            releaseAfter,
            c.mandateHash,
            c.amberCommitment,
            digest,
            keccak256(abi.encodePacked(qx, qy)),
            degraded
        );
        emit PremiumPaid(c.coverageId, c.agentId, c.premium);
        // forge-lint: disable-end(reentrancy-events)
    }

    /// @inheritdoc IKeelsonBondVault
    /// @dev Permissionless, and open while paused: a pause stops new coverage only.
    function releaseCoverage(bytes32 coverageId) external nonReentrant {
        CoverageState storage cov = _coverages[coverageId];
        if (cov.status != Status.Active || block.timestamp <= cov.releaseAfter) revert NotReleasable();
        if (cov.pendingSlashes != 0) revert SlashPending();
        cov.status = Status.Released;
        uint96 amount = cov.amount - slashed[coverageId];
        Bond storage bond = _bonds[cov.agentId];
        bond.locked -= amount;
        bond.free += amount;
        // forge-lint: disable-next-line(reentrancy-events)
        emit CoverageReleased(coverageId, cov.agentId, amount);
    }

    /// @inheritdoc IKeelsonBondVault
    /// @dev The funds stay slashable until `completeWithdrawal`, which pays only the signed `to`.
    function requestWithdrawal(
        uint256 agentId,
        uint128 amount,
        address to,
        uint256 nonce,
        uint256 deadline,
        bytes calldata ownerSig
    ) external nonReentrant returns (uint256 id) {
        if (block.timestamp > deadline) revert Expired();
        if (amount == 0 || to == address(0)) revert ZeroAmount();
        address signer = _authority(
            agentId, _hashTypedDataV4(KeelsonTypes.hashWithdrawal(agentId, amount, to, nonce, deadline)), ownerSig
        );
        if (signer == address(0)) revert NotAgentAuthority();
        _useCheckedNonce(signer, nonce);
        Bond storage bond = _bonds[agentId];
        if (bond.free < amount) revert InsufficientBond();
        bond.free -= amount;
        bond.queued += amount;
        uint40 readyAt = (block.timestamp + _params.withdrawalDelay).toUint40();
        id = ++withdrawalCount;
        _withdrawals[id] = Withdrawal({amount: amount, agentId: agentId.toUint64(), readyAt: readyAt, to: to});
        // forge-lint: disable-next-line(reentrancy-events)
        emit WithdrawalQueued(id, agentId, amount, to, readyAt);
    }

    /// @inheritdoc IKeelsonBondVault
    /// @dev Pays what slashing left of the queue, at most the requested amount. Permissionless and open while paused.
    function completeWithdrawal(uint256 id) external nonReentrant {
        Withdrawal memory w = _withdrawals[id];
        if (w.amount == 0) revert UnknownWithdrawal();
        if (block.timestamp < w.readyAt) revert NotReady();
        if (pendingSlashes[w.agentId] != 0) revert SlashPending();
        delete _withdrawals[id];
        Bond storage bond = _bonds[w.agentId];
        uint128 paid = w.amount < bond.queued ? w.amount : bond.queued;
        bond.queued -= paid;
        if (paid != 0) pyusd.safeTransfer(w.to, paid);
        // forge-lint: disable-next-line(reentrancy-events)
        emit WithdrawalCompleted(id, paid);
    }

    /// @inheritdoc IKeelsonBondVault
    function setPayoutAddress(
        address merchant,
        address payout,
        uint256 nonce,
        uint256 deadline,
        bytes calldata merchantSig
    ) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(KeelsonTypes.hashPayoutAddress(merchant, payout, nonce, deadline));
        if (!SignatureChecker.isValidSignatureNowCalldata(merchant, digest, merchantSig)) revert InvalidSignature();
        _useCheckedNonce(merchant, nonce);
        payoutAddress[merchant] = payout;
        // forge-lint: disable-next-line(reentrancy-events)
        emit PayoutAddressSet(merchant, payout);
    }

    /// @inheritdoc IKeelsonBondVault
    /// @dev The batch must name a checkpoint anchored for this vault's log: both legs signed it and the chain checked it
    /// extends every earlier anchor. Each purchase's passkey assertion was checked by the legs and is in that log.
    function lockCoverageBatch(KeelsonTypes.CoverageBatch calldata b, bytes calldata operatorSig)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 batchId)
    {
        batchId = KeelsonTypes.hash(b);
        if (_batches[batchId].status != Status.None) revert BatchExists();
        if (b.expiresAt <= block.timestamp) revert Expired();
        Params memory p = _params;
        if (b.expiresAt < block.timestamp + p.disputeWindow) revert WindowTooShort();
        if (_authority(b.agentId, _hashTypedDataV4(batchId), operatorSig) == address(0)) {
            revert InvalidOperatorSignature();
        }
        if (b.checkpointRoot == 0 || anchor.rootAt(logOrigin, b.treeSize) != b.checkpointRoot) revert NotAnchored();

        Bond storage bond = _bonds[b.agentId];
        uint256 debit = uint256(b.total) + b.premium;
        if (bond.free < debit) revert InsufficientBond();
        // forge-lint: disable-next-line(unsafe-typecast)
        bond.free -= uint128(debit);
        bond.locked += b.total;
        _batches[batchId] = BatchState({
            locked: b.total,
            agentId: b.agentId.toUint64(),
            releaseAfter: (uint256(b.expiresAt) + p.grace).toUint40(),
            status: Status.Active
        });
        batchRoot[batchId] = b.root;
        if (b.premium != 0) pyusd.safeTransfer(reserve, b.premium);
        // forge-lint: disable-next-line(reentrancy-events)
        emit CoverageBatchLocked(batchId, b.agentId, b.root, b.total, b.premium, b.checkpointRoot, b.treeSize);
    }

    /// @inheritdoc IKeelsonBondVault
    function releaseBatch(bytes32 batchId) external nonReentrant {
        BatchState storage batch = _batches[batchId];
        if (batch.status != Status.Active || block.timestamp <= batch.releaseAfter) revert NotReleasable();
        if (pendingSlashes[batch.agentId] != 0) revert SlashPending();
        batch.status = Status.Released;
        uint128 amount = batch.locked - batchSlashed[batchId];
        Bond storage bond = _bonds[batch.agentId];
        bond.locked -= amount;
        bond.free += amount;
        // forge-lint: disable-next-line(reentrancy-events)
        emit CoverageBatchReleased(batchId, batch.agentId, amount);
    }

    function setParams(Params calldata p) external restricted {
        _setParams(p);
    }

    /// @notice Stops new coverage only; releases and withdrawals keep working.
    function pause() external restricted {
        _pause();
    }

    function unpause() external restricted {
        _unpause();
    }

    /// @inheritdoc IKeelsonBondVault
    function bonds(uint256 agentId) external view returns (Bond memory) {
        return _bonds[agentId];
    }

    /// @inheritdoc IKeelsonBondVault
    function params() external view returns (Params memory) {
        return _params;
    }

    /// @inheritdoc IKeelsonBondVault
    function coverages(bytes32 coverageId) external view returns (CoverageState memory) {
        return _coverages[coverageId];
    }

    /// @inheritdoc IKeelsonBondVault
    function batches(bytes32 batchId) external view returns (BatchState memory) {
        return _batches[batchId];
    }

    /// @inheritdoc IKeelsonBondVault
    function withdrawals(uint256 id) external view returns (Withdrawal memory) {
        return _withdrawals[id];
    }

    /// @inheritdoc IKeelsonBondVault
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _credit(uint256 agentId, address from, uint256 amount) internal {
        _bonds[agentId].free += amount.toUint128();
        // forge-lint: disable-next-line(reentrancy-events)
        emit BondDeposited(agentId, from, amount);
    }

    /// @dev A slash queued at the end of the dispute and veto windows must still find the funds a withdrawal requested
    /// meanwhile.
    function _setParams(Params memory p) internal {
        if (p.withdrawalDelay < uint256(p.disputeWindow) + p.vetoWindow + p.grace) revert InvalidParams();
        _params = p;
        // forge-lint: disable-next-line(reentrancy-events)
        emit ParamsSet(p);
    }

    /// @dev Whether the agent's ERC-8004 owner, or its agent wallet, signed `digest`; returns that signer.
    function _authority(uint256 agentId, bytes32 digest, bytes calldata sig) internal view returns (address) {
        address owner = identity.ownerOf(agentId);
        if (SignatureChecker.isValidSignatureNowCalldata(owner, digest, sig)) return owner;
        address wallet = identity.getAgentWallet(agentId);
        if (wallet != address(0) && SignatureChecker.isValidSignatureNowCalldata(wallet, digest, sig)) return wallet;
        return address(0);
    }
}
