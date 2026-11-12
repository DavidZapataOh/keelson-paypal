// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../../script/CoverageVector.sol";
import {KeelsonBondVault} from "../../src/KeelsonBondVault.sol";
import {KeelsonReserve} from "../../src/KeelsonReserve.sol";
import {IKeelsonBondVault} from "../../src/interfaces/IKeelsonBondVault.sol";
import {IVerdictVerifier} from "../../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {IPyusd} from "../utils/IPyusd.sol";
import {BondVaultHandler} from "./BondVaultHandler.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice The parts of PaxosTokenV2 that lift a freeze or a pause.
interface IPyusdAdmin {
    function unfreeze(address addr) external;
    function unpause() external;
}

/// @notice Grows `BondVaultHandler` with every way funds leave the vault and the reserve: slashes (2-of-2 and degraded,
/// instant and queued), their execution and veto, claims of failed payouts, warranties, and the real Paxos freeze and
/// pause by their role holders and the vault's pause by the Guardian Safe. It also submits what must fail (forged or
/// lone-Nitro signatures, replayed disputes, the wrong liable party, early completions) and records whether the contracts
/// accepted it. Each action runs as a self-call so a revert never loses the counters: `calls[selector]` counts every
/// invocation, `ok[selector]` only those that changed state.
contract KeelsonHandler is BondVaultHandler {
    struct Config {
        KeelsonReserve reserve;
        IVerdictVerifier verifier;
        uint256 tdxKey;
        uint256 nitroKey;
        uint256 merchantKey;
        uint64 treeSize;
        bytes32 checkpointRoot;
        address guardian;
        address assetProtector;
        /// @dev Medusa has no `recordLogs`; without it I12 is checked on the queued slashes' stored digests only.
        bool recordLogs;
    }

    /// @notice A dispute the handler signed a verdict for, whether or not the contracts accepted it.
    struct Dispute {
        bytes32 coverageId;
        address recipient;
        uint96 amount;
        uint8 liable;
        bool degraded;
        bool warranty;
        uint40 settledAt;
        uint40 executedAt;
        bytes32 digest;
    }

    error Skip();
    error ExpectedRevert();

    uint256 internal constant SIGNATURE_LENGTH = 65;
    uint40 internal constant DEGRADED_WINDOW = 72 hours;
    uint8 internal constant LIABLE_OPERATOR = 1;
    uint8 internal constant LIABLE_KEELSON = 2;
    uint256 internal constant STRANGER_KEY = uint256(keccak256("unregistered verdict signer"));

    KeelsonReserve internal immutable reserve;
    IVerdictVerifier internal immutable verifier;
    uint256 internal immutable tdxKey;
    uint256 internal immutable nitroKey;
    uint256 internal immutable merchantKey;
    address public immutable merchant;
    address public immutable claimTo;
    uint64 internal immutable treeSize;
    bytes32 internal immutable checkpointRoot;
    address internal immutable guardian;
    address internal immutable assetProtector;
    bool internal immutable recordLogs;

    mapping(bytes4 selector => uint256) public calls;
    mapping(bytes4 selector => uint256) public ok;

    /// @dev Addresses whose PYUSD inflows are attributed to the vault.
    address[] internal _tracked;
    mapping(address => uint256) public ghostOut;
    mapping(address => uint256) public ghostEntitled;
    uint256 public ghostVaultOut;

    bytes32[] internal _disputeIds;
    mapping(bytes32 disputeId => Dispute) internal _disputes;
    mapping(bytes32 disputeId => uint256) public ghostSettled;
    mapping(bytes32 disputeId => uint256) public ghostVetoes;
    bytes32[] internal _invalidIds;
    bytes32[] internal _queued;
    mapping(uint256 withdrawalId => address) internal _requestedTo;
    uint256 internal _disputeNonce;

    uint256 public ghostUnsignedSuccess;
    uint256 public ghostNitroOnlySuccess;
    uint256 public ghostWarrantyNot2of2;
    uint256 public ghostWrongLiableSuccess;
    uint256 public ghostPayeeMismatch;
    uint256 public ghostEarlyCompletions;
    uint256 public ghostEarlyExecutions;
    uint256 public ghostUnauthorizedRequests;
    uint256 public ghostMisdirectedWithdrawals;
    uint256 public ghostDigestMismatch;
    uint256 public ghostUnknownSlashed;
    uint256 public ghostSlashedEvents;

    constructor(
        KeelsonBondVault vault_,
        IPyusd pyusd_,
        uint256 agentId_,
        uint256 operatorKey_,
        uint256[] memory funderKeys_,
        Vector[] memory vectors_,
        Config memory c
    ) BondVaultHandler(vault_, pyusd_, agentId_, operatorKey_, funderKeys_, vectors_) {
        reserve = c.reserve;
        verifier = c.verifier;
        tdxKey = c.tdxKey;
        nitroKey = c.nitroKey;
        merchantKey = c.merchantKey;
        merchant = vm.addr(c.merchantKey);
        claimTo = vm.addr(uint256(keccak256("claim recipient")));
        treeSize = c.treeSize;
        checkpointRoot = c.checkpointRoot;
        guardian = c.guardian;
        assetProtector = c.assetProtector;
        recordLogs = c.recordLogs;
        // EIP-3009 salts the test's own deposits may have used.
        salts = 1000;
        _tracked.push(merchant);
        _tracked.push(recipient);
        _tracked.push(address(c.reserve));
        _tracked.push(claimTo);
    }

    /// @dev A fresh `TIMESTAMP` read: within one frame the IR optimizer may reuse an earlier one across a `vm.warp`.
    function now_() external view returns (uint256) {
        return block.timestamp;
    }

    // ---------------------------------------------------------------- views for the properties

    function bondVault() external view returns (KeelsonBondVault) {
        return vault;
    }

    function warrantyReserve() external view returns (KeelsonReserve) {
        return reserve;
    }

    function token() external view returns (IPyusd) {
        return pyusd;
    }

    function trackedCount() external view returns (uint256) {
        return _tracked.length;
    }

    function tracked(uint256 i) external view returns (address) {
        return _tracked[i];
    }

    function disputeCount() external view returns (uint256) {
        return _disputeIds.length;
    }

    function disputeAt(uint256 i) external view returns (bytes32) {
        return _disputeIds[i];
    }

    function dispute(bytes32 id) external view returns (Dispute memory) {
        return _disputes[id];
    }

    function invalidCount() external view returns (uint256) {
        return _invalidIds.length;
    }

    function invalidAt(uint256 i) external view returns (bytes32) {
        return _invalidIds[i];
    }

    function vectorCount() external view returns (uint256) {
        return vectors.length;
    }

    function coverageIdAt(uint256 i) external view returns (bytes32) {
        return vectors[i].coverage.coverageId;
    }

    function vectorDegraded(uint256 i) external view returns (bool) {
        return vectors[i].degraded;
    }

    // ---------------------------------------------------------------- 04's actions, counted

    function deposit(uint256 funderSeed, uint256 amountSeed, uint256 agentSeed) public override {
        if (_outer(this.deposit.selector)) {
            try this.deposit(funderSeed, amountSeed, agentSeed) {
                ++ok[this.deposit.selector];
            } catch {}
            return;
        }
        uint256[] memory before = _balances();
        uint256 prior = deposited;
        super.deposit(funderSeed, amountSeed, agentSeed);
        if (deposited == prior) revert Skip();
        _vaultFlows(before);
    }

    /// @dev One call in eight first submits a 2-of-2 vector's coverage with the Nitro countersignature alone (DEG1).
    function lock(uint256 which) public override {
        if (_outer(this.lock.selector)) {
            try this.lock(which) {
                ++ok[this.lock.selector];
            } catch {}
            return;
        }
        uint256 i = which % vectors.length;
        if (locked[i]) revert Skip();
        uint256[] memory before = _balances();
        if ((which >> 8) % 8 == 7 && !vectors[i].degraded) {
            _lockNitroOnly(i);
        } else {
            _lockValid(i);
        }
        _vaultFlows(before);
    }

    /// @dev Half the calls first wait out the coverage.
    function release(uint256 which) public override {
        if (_outer(this.release.selector)) {
            try this.release(which) {
                ++ok[this.release.selector];
            } catch {}
            return;
        }
        uint256 i = which % vectors.length;
        bytes32 id = vectors[i].coverage.coverageId;
        IKeelsonBondVault.CoverageState memory c = vault.coverages(id);
        if (c.status != IKeelsonBondVault.Status.Active) revert Skip();
        if ((which >> 8) % 2 == 0 && this.now_() <= c.releaseAfter) vm.warp(uint256(c.releaseAfter) + 1);
        uint256[] memory before = _balances();
        super.release(i);
        if (vault.coverages(id).status != IKeelsonBondVault.Status.Released) revert Skip();
        _vaultFlows(before);
    }

    /// @dev One call in eight is signed by a key that is neither the agent's owner nor its wallet (I6).
    function request(uint256 amountSeed) public override {
        if (_outer(this.request.selector)) {
            try this.request(amountSeed) {
                ++ok[this.request.selector];
            } catch {}
            return;
        }
        uint256[] memory before = _balances();
        if ((amountSeed >> 128) % 8 == 7) {
            _requestUnauthorized(amountSeed);
        } else {
            uint256 count = pendingWithdrawals.length;
            super.request(amountSeed);
            if (pendingWithdrawals.length == count) revert Skip();
            _requestedTo[pendingWithdrawals[count]] = recipient;
        }
        _vaultFlows(before);
    }

    /// @dev Attempts completion whether or not it is due; half the calls first wait until `readyAt` (I5, I6).
    function complete(uint256 which) public override {
        if (_outer(this.complete.selector)) {
            try this.complete(which) {
                ++ok[this.complete.selector];
            } catch {}
            return;
        }
        if (pendingWithdrawals.length == 0) revert Skip();
        uint256 i = which % pendingWithdrawals.length;
        uint256 id = pendingWithdrawals[i];
        IKeelsonBondVault.Withdrawal memory w = vault.withdrawals(id);
        if ((which >> 8) % 2 == 0 && this.now_() < w.readyAt) vm.warp(w.readyAt);
        bool early = this.now_() < w.readyAt || vault.pendingSlashes(w.agentId) != 0;
        uint128 queued = vault.bonds(w.agentId).queued;
        uint128 paid = w.amount < queued ? w.amount : queued;
        uint256[] memory before = _balances();
        uint256 toBefore = pyusd.balanceOf(w.to);
        uint256 vaultBefore = pyusd.balanceOf(address(vault));

        vault.completeWithdrawal(id);

        if (early) ++ghostEarlyCompletions;
        uint256 received = pyusd.balanceOf(w.to) - toBefore;
        if (w.to != _requestedTo[id] || received != paid || vaultBefore - pyusd.balanceOf(address(vault)) != paid) {
            ++ghostMisdirectedWithdrawals;
        }
        ghostEntitled[w.to] += paid;
        withdrawn += received;
        pendingWithdrawals[i] = pendingWithdrawals[pendingWithdrawals.length - 1];
        pendingWithdrawals.pop();
        _vaultFlows(before);
    }

    /// @dev Mostly minutes, so the 2-of-2 coverages' ten-minute windows stay reachable; one call in sixteen jumps up
    /// to 73 hours, past the degraded window. Actions that wait for a deadline warp to it themselves.
    function warp(uint256 secondsSeed) public override {
        if (_outer(this.warp.selector)) {
            try this.warp(secondsSeed) {
                ++ok[this.warp.selector];
            } catch {}
            return;
        }
        uint256 step =
            secondsSeed % 16 == 15 ? bound(secondsSeed >> 2, 1 hours, 73 hours) : bound(secondsSeed >> 2, 1, 5 minutes);
        vm.warp(this.now_() + step);
    }

    // ---------------------------------------------------------------- settlement

    /// @param seed Picks the coverage, the amount and the variant: a replayed dispute, a party other than the operator
    /// named liable, or (with `validSig` false) a forged signature set.
    /// @param degraded Sign with the TDX leg alone.
    /// @param validSig False submits signatures that must be rejected: the Nitro leg alone, an unregistered key in the
    /// TDX slot, or real signatures over a different verdict.
    function slash(uint256 seed, bool degraded, bool validSig) external {
        if (_outer(this.slash.selector)) {
            try this.slash(seed, degraded, validSig) {
                ++ok[this.slash.selector];
            } catch {}
            return;
        }
        uint256 i = seed % vectors.length;
        if (!locked[i]) _lockValid(i);
        Vector memory v = vectors[i];
        IKeelsonBondVault.CoverageState memory c = vault.coverages(v.coverage.coverageId);
        uint96 amount = _amount(seed >> 8, c.amount, _remaining(v.coverage.coverageId, c.amount));

        bool replay = (seed >> 40) % 8 == 7 && _settledIndex(seed >> 64) != type(uint256).max;
        uint8 liable = _liable(seed >> 48, LIABLE_OPERATOR);
        KeelsonTypes.Verdict memory verdict =
            _newVerdict(v, amount, liable, replay ? _settledIndex(seed >> 64) : type(uint256).max);
        bytes32 digest = verifier.hashTypedData(KeelsonTypes.hash(verdict));
        bytes memory sigs;
        uint256 variant = (seed >> 72) % 3;
        if (validSig) {
            sigs = degraded
                ? _signWith(tdxKey, digest)
                : bytes.concat(_signWith(tdxKey, digest), _signWith(nitroKey, digest));
        } else {
            sigs = _forged(verdict, digest, degraded, variant);
        }
        bool effectiveDegraded = degraded || c.degraded;
        if (!replay) _record(verdict, digest, effectiveDegraded, false);
        if (!validSig) _invalidIds.push(verdict.disputeId);

        uint256[] memory before = _balances();
        uint256 claimableBefore = vault.claimable(_recipientOf(merchant));
        if (recordLogs) vm.recordLogs();
        try vault.slash(verdict, treeSize, sigs) {}
        catch {
            revert ExpectedRevert();
        }

        ++ghostSettled[verdict.disputeId];
        if (!validSig) {
            ++ghostUnsignedSuccess;
            if (!degraded && variant == 0) ++ghostNitroOnlySuccess;
        }
        if (liable != LIABLE_OPERATOR) ++ghostWrongLiableSuccess;
        if (!replay) _disputes[verdict.disputeId].settledAt = uint40(this.now_());

        address to = _recipientOf(verdict.payee);
        IKeelsonBondVault.QueuedSlash memory q = vault.queuedSlashes(verdict.disputeId);
        uint256 credited = pyusd.balanceOf(to) - before[_indexOf(to)] + vault.claimable(to) - claimableBefore;
        if (q.status == IKeelsonBondVault.SlashStatus.None) {
            if (credited != amount) ++ghostPayeeMismatch;
            ghostEntitled[to] += amount;
        } else {
            if (credited != 0) ++ghostPayeeMismatch;
            _queued.push(verdict.disputeId);
        }
        _vaultFlows(before);
        _checkSlashedLogs();
    }

    /// @dev Half the calls first wait until the slash is due; the others try it as it stands.
    function executeSlash(uint256 seed) external {
        if (_outer(this.executeSlash.selector)) {
            try this.executeSlash(seed) {
                ++ok[this.executeSlash.selector];
            } catch {}
            return;
        }
        (bytes32 id, IKeelsonBondVault.QueuedSlash memory q) = _pickQueued(seed);
        if ((seed >> 8) % 2 == 0 && this.now_() < q.readyAt) vm.warp(q.readyAt);
        bool early = this.now_() < q.readyAt;
        address to = _recipientOf(q.payee);
        uint256[] memory before = _balances();
        uint256 claimableBefore = vault.claimable(to);
        if (recordLogs) vm.recordLogs();

        vault.executeSlash(id);

        if (early) ++ghostEarlyExecutions;
        _disputes[id].executedAt = uint40(this.now_());
        if (pyusd.balanceOf(to) - before[_indexOf(to)] + vault.claimable(to) - claimableBefore != q.amount) {
            ++ghostPayeeMismatch;
        }
        ghostEntitled[to] += q.amount;
        _vaultFlows(before);
        _checkSlashedLogs();
    }

    /// @dev As the Guardian Safe, which holds `GUARDIAN_ROLE`.
    function vetoSlash(uint256 seed) external {
        if (_outer(this.vetoSlash.selector)) {
            try this.vetoSlash(seed) {
                ++ok[this.vetoSlash.selector];
            } catch {}
            return;
        }
        (bytes32 id,) = _pickQueued(seed);
        uint256[] memory before = _balances();
        vm.prank(guardian);
        vault.vetoSlash(id, "invariant fuzzing");
        // The veto reopens the dispute: its settlement is undone, and a later one counts anew.
        --ghostSettled[id];
        ++ghostVetoes[id];
        _vaultFlows(before);
    }

    /// @dev The merchant claims what a failed payout left, from the vault or (odd seeds) the reserve, whichever owes it
    /// something, to itself or to another address it chose that is not frozen; half the time a relayer submits the
    /// merchant's signed claim instead.
    function claim(uint256 seed) external {
        if (_outer(this.claim.selector)) {
            try this.claim(seed) {
                ++ok[this.claim.selector];
            } catch {}
            return;
        }
        address account = _recipientOf(merchant);
        address to = (seed >> 8) % 2 == 0 ? account : claimTo;
        if (pyusd.isFrozen(to)) to = to == claimTo ? account : claimTo;
        uint256 fromVault = vault.claimable(account);
        uint256 fromReserve = reserve.claimable(account);
        uint256[] memory before = _balances();
        uint256 toBefore = pyusd.balanceOf(to);
        if (seed % 2 == 0 ? fromVault != 0 || fromReserve == 0 : fromReserve == 0) {
            uint256 amount = vault.claimable(account);
            if (amount == 0) revert Skip();
            (uint256 nonce, uint256 deadline, bytes memory sig) =
                _claimAuth(seed, account, to, vault.nonces(account), vault.domainSeparator());
            vault.claim(account, to, nonce, deadline, sig);
            if (pyusd.balanceOf(to) - toBefore != amount) ++ghostPayeeMismatch;
            ghostEntitled[to] += amount;
            _vaultFlows(before);
        } else {
            uint256 amount = reserve.claimable(account);
            if (amount == 0) revert Skip();
            (uint256 nonce, uint256 deadline, bytes memory sig) =
                _claimAuth(seed, account, to, reserve.nonces(account), reserve.domainSeparator());
            reserve.claim(account, to, nonce, deadline, sig);
            if (pyusd.balanceOf(to) - toBefore != amount) ++ghostPayeeMismatch;
            _reserveFlows(before);
        }
    }

    /// @dev A verdict naming Keelson liable, paid by the reserve. One call in eight names another party, and `degraded`
    /// signs with the TDX leg alone: both must be rejected.
    function payWarranty(uint256 seed, bool degraded) external {
        if (_outer(this.payWarranty.selector)) {
            try this.payWarranty(seed, degraded) {
                ++ok[this.payWarranty.selector];
            } catch {}
            return;
        }
        uint256 i = seed % vectors.length;
        if (!locked[i]) _lockValid(i);
        Vector memory v = vectors[i];
        IKeelsonBondVault.CoverageState memory c = vault.coverages(v.coverage.coverageId);
        uint256 fits = _remaining(v.coverage.coverageId, c.amount);
        uint256 assets = reserve.totalAssets();
        if (assets < fits) fits = assets;
        if (reserve.rateLimitAvailable() < fits) fits = reserve.rateLimitAvailable();
        uint96 amount = _amount(seed >> 8, c.amount, fits);

        bool replay = (seed >> 40) % 8 == 7 && _settledIndex(seed >> 64) != type(uint256).max;
        uint8 liable = _liable(seed >> 48, LIABLE_KEELSON);
        KeelsonTypes.Verdict memory verdict =
            _newVerdict(v, amount, liable, replay ? _settledIndex(seed >> 64) : type(uint256).max);
        bytes32 digest = verifier.hashTypedData(KeelsonTypes.hash(verdict));
        bytes memory sigs =
            degraded ? _signWith(tdxKey, digest) : bytes.concat(_signWith(tdxKey, digest), _signWith(nitroKey, digest));
        if (!replay) _record(verdict, digest, degraded, true);
        if (degraded) _invalidIds.push(verdict.disputeId);

        address to = _recipientOf(verdict.payee);
        uint256[] memory before = _balances();
        uint256 claimableBefore = reserve.claimable(to);
        try reserve.payWarranty(verdict, treeSize, sigs) {}
        catch {
            revert ExpectedRevert();
        }

        ++ghostSettled[verdict.disputeId];
        if (degraded) ++ghostWarrantyNot2of2;
        if (liable != LIABLE_KEELSON) ++ghostWrongLiableSuccess;
        if (!replay) _disputes[verdict.disputeId].settledAt = uint40(this.now_());
        if (pyusd.balanceOf(to) - before[_indexOf(to)] + reserve.claimable(to) - claimableBefore != amount) {
            ++ghostPayeeMismatch;
        }
        _reserveFlows(before);
    }

    // ---------------------------------------------------------------- Paxos and the Guardian

    /// @dev The real `freeze`, by the real asset-protection role holder, of a payee, a claim recipient, the operator's
    /// treasury, the reserve or the vault.
    function freeze(uint256 who) external {
        if (_outer(this.freeze.selector)) {
            try this.freeze(who) {
                ++ok[this.freeze.selector];
            } catch {}
            return;
        }
        address target = _freezable(who);
        if (pyusd.isFrozen(target)) revert Skip();
        uint256[] memory before = _balances();
        vm.prank(assetProtector);
        pyusd.freeze(target);
        _vaultFlows(before);
    }

    function unfreeze(uint256 who) external {
        if (_outer(this.unfreeze.selector)) {
            try this.unfreeze(who) {
                ++ok[this.unfreeze.selector];
            } catch {}
            return;
        }
        address target = _freezable(who);
        for (uint256 k = 1; k < 8 && !pyusd.isFrozen(target); ++k) {
            target = _freezable(who + k);
        }
        if (!pyusd.isFrozen(target)) revert Skip();
        vm.prank(assetProtector);
        IPyusdAdmin(address(pyusd)).unfreeze(target);
    }

    function pauseToken() external {
        if (_outer(this.pauseToken.selector)) {
            try this.pauseToken() {
                ++ok[this.pauseToken.selector];
            } catch {}
            return;
        }
        if (pyusd.paused()) revert Skip();
        vm.prank(assetProtector);
        pyusd.pause();
    }

    function unpauseToken() external {
        if (_outer(this.unpauseToken.selector)) {
            try this.unpauseToken() {
                ++ok[this.unpauseToken.selector];
            } catch {}
            return;
        }
        if (!pyusd.paused()) revert Skip();
        vm.prank(assetProtector);
        IPyusdAdmin(address(pyusd)).unpause();
    }

    function pauseVault() external {
        if (_outer(this.pauseVault.selector)) {
            try this.pauseVault() {
                ++ok[this.pauseVault.selector];
            } catch {}
            return;
        }
        if (vault.paused()) revert Skip();
        uint256[] memory before = _balances();
        vm.prank(guardian);
        vault.pause();
        _vaultFlows(before);
    }

    function unpauseVault() external {
        if (_outer(this.unpauseVault.selector)) {
            try this.unpauseVault() {
                ++ok[this.unpauseVault.selector];
            } catch {}
            return;
        }
        if (!vault.paused()) revert Skip();
        vm.prank(guardian);
        vault.unpause();
    }

    /// @notice Every action the fuzzers target.
    function selectors() external pure returns (bytes4[] memory s) {
        s = new bytes4[](17);
        s[0] = this.deposit.selector;
        s[1] = this.lock.selector;
        s[2] = this.release.selector;
        s[3] = this.request.selector;
        s[4] = this.complete.selector;
        s[5] = this.warp.selector;
        s[6] = this.slash.selector;
        s[7] = this.executeSlash.selector;
        s[8] = this.vetoSlash.selector;
        s[9] = this.claim.selector;
        s[10] = this.payWarranty.selector;
        s[11] = this.freeze.selector;
        s[12] = this.unfreeze.selector;
        s[13] = this.pauseToken.selector;
        s[14] = this.unpauseToken.selector;
        s[15] = this.pauseVault.selector;
        s[16] = this.unpauseVault.selector;
    }

    // ---------------------------------------------------------------- internals

    /// @dev True for the fuzzer's call, which counts it and re-enters as a self-call; false inside that self-call.
    function _outer(bytes4 selector) internal returns (bool) {
        if (msg.sender == address(this)) return false;
        ++calls[selector];
        return true;
    }

    /// @dev Either the account itself calls (no signature), or a relayer calls with the account's EIP-712 claim.
    function _claimAuth(uint256 seed, address account, address to, uint256 nonce, bytes32 domain)
        internal
        returns (uint256, uint256, bytes memory)
    {
        if ((seed >> 16) % 2 == 0 || account != merchant) {
            vm.prank(account);
            return (0, 0, "");
        }
        uint256 deadline = this.now_() + 1 hours;
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", domain, KeelsonTypes.hashClaim(account, to, nonce, deadline)));
        return (nonce, deadline, _signWith(merchantKey, digest));
    }

    function _lockValid(uint256 i) internal {
        super.lock(i);
        if (!locked[i]) revert Skip();
        ghostEntitled[address(reserve)] += vectors[i].coverage.premium;
    }

    /// @dev One seed in eight names a party other than `expected`.
    function _liable(uint256 seed, uint8 expected) internal pure returns (uint8 liable) {
        if (seed % 8 != 7) return expected;
        liable = uint8(seed >> 8);
        if (liable == expected) liable = expected == LIABLE_OPERATOR ? LIABLE_KEELSON : LIABLE_OPERATOR;
    }

    /// @dev The index of a recorded dispute either contract already settled, or `type(uint256).max` if none.
    function _settledIndex(uint256 seed) internal view returns (uint256) {
        uint256 n = _disputeIds.length;
        for (uint256 k; k < n; ++k) {
            uint256 i = (seed + k) % n;
            if (vault.settled(_disputeIds[i]) || reserve.settled(_disputeIds[i])) return i;
        }
        return type(uint256).max;
    }

    function _lockNitroOnly(uint256 i) internal {
        Vector memory v = vectors[i];
        if (vault.bonds(agentId).free < uint256(v.coverage.amount) + v.coverage.premium) revert Skip();
        if (this.now_() < v.countersign.issuedAt) vm.warp(v.countersign.issuedAt);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(
            operatorKey, keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), KeelsonTypes.hash(v.coverage)))
        );
        try vault.lockCoverage(
            v.coverage, v.countersign, v.hSd, v.assertion, v.qx, v.qy, abi.encodePacked(r, s, sv), v.nitro
        ) {
            ++ghostNitroOnlySuccess;
        } catch {
            revert ExpectedRevert();
        }
    }

    function _requestUnauthorized(uint256 amountSeed) internal {
        uint128 free = vault.bonds(agentId).free;
        if (free == 0) revert Skip();
        uint128 amount = uint128(bound(amountSeed, 1, free));
        address stranger = vm.addr(STRANGER_KEY);
        uint256 nonce = vault.nonces(stranger);
        uint256 deadline = this.now_() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            STRANGER_KEY,
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    vault.domainSeparator(),
                    KeelsonTypes.hashWithdrawal(agentId, amount, stranger, nonce, deadline)
                )
            )
        );
        try vault.requestWithdrawal(agentId, amount, stranger, nonce, deadline, abi.encodePacked(r, s, v)) {
            ++ghostUnauthorizedRequests;
        } catch {
            revert ExpectedRevert();
        }
    }

    /// @dev `index` below `type(uint256).max` reuses that recorded dispute's id (a replay); otherwise a fresh id.
    function _newVerdict(Vector memory v, uint96 amount, uint8 liable, uint256 index)
        internal
        returns (KeelsonTypes.Verdict memory)
    {
        bytes32 id = index == type(uint256).max
            ? keccak256(abi.encode("invariant dispute", ++_disputeNonce))
            : _disputeIds[index];
        uint256 t = this.now_();
        return KeelsonTypes.Verdict({
            disputeId: id,
            coverageId: v.coverage.coverageId,
            agentId: v.coverage.agentId,
            payee: merchant,
            amount: amount,
            ruleId: liable == LIABLE_OPERATOR ? 61 : 60,
            liable: liable,
            fieldId: 9,
            evidenceHash: keccak256(abi.encode("evidence", id)),
            inputsHash: keccak256(abi.encode("inputs", id)),
            policySetHash: v.countersign.policySetHash,
            checkpointRoot: checkpointRoot,
            issuedAt: uint40(t),
            deadline: uint40(t + 1 hours)
        });
    }

    function _record(KeelsonTypes.Verdict memory v, bytes32 digest, bool degraded, bool warranty) internal {
        _disputeIds.push(v.disputeId);
        _disputes[v.disputeId] = Dispute({
            coverageId: v.coverageId,
            recipient: _recipientOf(v.payee),
            amount: v.amount,
            liable: v.liable,
            degraded: degraded,
            warranty: warranty,
            settledAt: 0,
            executedAt: 0,
            digest: digest
        });
    }

    function _forged(KeelsonTypes.Verdict memory v, bytes32 digest, bool degraded, uint256 variant)
        internal
        view
        returns (bytes memory)
    {
        if (degraded) return _signWith(variant == 0 ? nitroKey : STRANGER_KEY, digest);
        if (variant == 0) return _signWith(nitroKey, digest);
        if (variant == 1) return bytes.concat(_signWith(STRANGER_KEY, digest), _signWith(nitroKey, digest));
        // A copy: assigning a memory struct only aliases it.
        KeelsonTypes.Verdict memory other = abi.decode(abi.encode(v), (KeelsonTypes.Verdict));
        other.amount = v.amount + 1;
        bytes32 otherDigest = verifier.hashTypedData(KeelsonTypes.hash(other));
        return bytes.concat(_signWith(tdxKey, otherDigest), _signWith(nitroKey, otherDigest));
    }

    function _signWith(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Three seeds in four fit what the coverage (and for warranties the reserve) can still pay; the rest range
    /// over the whole coverage, so overshoots are tried too.
    function _amount(uint256 seed, uint96 coverageAmount, uint256 fits) internal pure returns (uint96) {
        if (coverageAmount == 0) revert Skip();
        if (seed % 4 != 3 && fits != 0) return uint96(bound(seed >> 2, 1, fits));
        return uint96(bound(seed >> 2, 1, coverageAmount));
    }

    function _remaining(bytes32 coverageId, uint96 coverageAmount) internal view returns (uint256) {
        uint256 used = uint256(vault.slashed(coverageId)) + reserve.warranted(coverageId);
        return used >= coverageAmount ? 0 : coverageAmount - used;
    }

    function _pickQueued(uint256 seed) internal view returns (bytes32 id, IKeelsonBondVault.QueuedSlash memory q) {
        uint256 n = _queued.length;
        for (uint256 k; k < n; ++k) {
            id = _queued[(seed + k) % n];
            q = vault.queuedSlashes(id);
            if (q.status == IKeelsonBondVault.SlashStatus.Queued) return (id, q);
        }
        revert Skip();
    }

    function _recipientOf(address payee) internal view returns (address to) {
        to = vault.payoutAddress(payee);
        if (to == address(0)) to = payee;
    }

    function _indexOf(address a) internal view returns (uint256) {
        for (uint256 i; i < _tracked.length; ++i) {
            if (_tracked[i] == a) return i;
        }
        revert Skip();
    }

    /// @dev Half the time the merchant, whose frozen payouts become claims; otherwise the operator's treasury, the
    /// reserve, the claim recipient or the vault.
    function _freezable(uint256 who) internal view returns (address) {
        uint256 k = who % 8;
        if (k < 4) return _tracked[0];
        return k == 7 ? address(vault) : _tracked[k - 3];
    }

    /// @dev The tracked addresses' balances, then the vault's.
    function _balances() internal view returns (uint256[] memory b) {
        uint256 n = _tracked.length;
        b = new uint256[](n + 1);
        for (uint256 i; i < n; ++i) {
            b[i] = pyusd.balanceOf(_tracked[i]);
        }
        b[n] = pyusd.balanceOf(address(vault));
    }

    /// @dev Attributes every tracked inflow during a vault action to the vault (I9).
    function _vaultFlows(uint256[] memory before) internal {
        uint256 n = _tracked.length;
        uint256 balance = pyusd.balanceOf(address(vault));
        if (balance < before[n]) ghostVaultOut += before[n] - balance;
        for (uint256 i; i < n; ++i) {
            uint256 b = pyusd.balanceOf(_tracked[i]);
            if (b > before[i]) ghostOut[_tracked[i]] += b - before[i];
        }
    }

    /// @dev A reserve action moves none of the vault's PYUSD; any that left is outflow no one is entitled to.
    function _reserveFlows(uint256[] memory before) internal {
        uint256 n = _tracked.length;
        uint256 balance = pyusd.balanceOf(address(vault));
        if (balance < before[n]) ghostVaultOut += before[n] - balance;
    }

    /// @dev I12: each `Slashed` the vault emitted carries the digest of the verdict this handler signed for it.
    function _checkSlashedLogs() internal {
        if (!recordLogs) return;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault) || logs[i].topics[0] != IKeelsonBondVault.Slashed.selector) continue;
            ++ghostSlashedEvents;
            bytes32 id = logs[i].topics[1];
            (,,,, bytes32 verdictDigest) = abi.decode(logs[i].data, (address, uint96, uint8, bytes32, bytes32));
            bytes32 signed = _disputes[id].digest;
            if (signed == 0) ++ghostUnknownSlashed;
            else if (verdictDigest != signed) ++ghostDigestMismatch;
        }
    }
}
