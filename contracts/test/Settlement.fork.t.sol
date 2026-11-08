// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../script/CoverageVector.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {IKeelsonReserve} from "../src/interfaces/IKeelsonReserve.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {SlashBase} from "./utils/SlashBase.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Amber and green disputes settled end to end on a fork of Arbitrum Sepolia with real PYUSD: bonds deposited by
/// EIP-3009, two coverages locked from the live vectors, the real `CheckpointAnchor`, an amber verdict slashing the
/// operator (at once, then through the veto queue) and a green one paid by the reserve that collected the premiums.
/// @dev Verdicts come from `vectors/verdict-amber.json` and `vectors/verdict-green.json` when they exist (signed by the
/// live legs), and are otherwise signed by the fork-only `VerdictSigners`; the assertions are the same either way.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract SettlementForkTest is SlashBase {
    using stdJson for string;

    uint256 internal constant SEED = 100e6;

    address internal treasury;
    Vector internal a;
    Vector internal b;

    function setUp() public override {
        super.setUp();
        // The faucet gives each funder 100 PYUSD a day, which backs one coverage; the second is backed by a fresh key's
        // PYUSD from the faucet's own wallet, deposited by EIP-3009 like the others.
        (address extra, uint256 extraKey) = makeAddrAndKey("second funder");
        _fundFromHolder(extra, 100e6);
        bytes32 salt = "second funder";
        bytes memory sig = _signReceiveWithAuthorization(
            extraKey, address(vault), 100e6, 0, type(uint256).max, keccak256(abi.encode(agentId, salt))
        );
        vault.depositWithAuthorization(agentId, extra, 100e6, 0, type(uint256).max, salt, sig);

        treasury = makeAddr("treasury");
        _fundFromHolder(treasury, SEED);
        vm.startPrank(treasury);
        pyusd.approve(address(reserve), SEED);
        reserve.deposit(SEED, treasury);
        vm.stopPrank();

        a = _locked(WEBAUTHN);
        b = _vector(PAYMENT);
        _lock(b);
    }

    /// @dev The live legs' verdict at `name`, if 07 recorded one, else the given one signed on the fork.
    function _signed(string memory name, KeelsonTypes.Verdict memory fallback_)
        internal
        view
        returns (KeelsonTypes.Verdict memory v, uint64 size, bytes memory sigs)
    {
        string memory path = string.concat(vm.projectRoot(), "/test/vectors/", name, ".json");
        if (!vm.exists(path)) return (fallback_, treeSize, _sign2of2(fallback_));
        string memory json = vm.readFile(path);
        v = abi.decode(json.parseRaw(".verdict"), (KeelsonTypes.Verdict));
        size = uint64(json.readUint(".treeSize"));
        sigs = bytes.concat(json.readBytes(".signatures.tdx"), json.readBytes(".signatures.nitro"));
    }

    function test_amberAndGreenSettle() public {
        uint256 premiums = uint256(a.coverage.premium) + b.coverage.premium;
        assertApproxEqAbs(reserve.totalAssets(), SEED + premiums, 0, "premiums in the reserve");

        // Amber, within the instant cap: the merchant is paid at once.
        (KeelsonTypes.Verdict memory amber, uint64 size, bytes memory sigs) =
            _signed("verdict-amber", _verdict(a, a.coverage.amount, OPERATOR, "PP-D-amber"));
        vm.expectEmit(address(vault));
        emit IKeelsonBondVault.Slashed(
            amber.disputeId,
            amber.coverageId,
            agentId,
            amber.payee,
            amber.amount,
            amber.fieldId,
            amber.evidenceHash,
            _digest(amber)
        );
        vault.slash(amber, size, sigs);
        assertEq(pyusd.balanceOf(amber.payee), amber.amount);
        assertEq(_bond().slashCount, 1);

        // Amber above a lowered cap: queued, then executed after the veto window.
        IKeelsonBondVault.Params memory p = vault.params();
        p.instantSlashCap = 10e6;
        _viaTimelock(address(vault), abi.encodeCall(vault.setParams, (p)));
        KeelsonTypes.Verdict memory queued = _verdict(b, 40e6, OPERATOR, "PP-D-amber-queued");
        _slash(queued);
        uint40 readyAt = vault.queuedSlashes(queued.disputeId).readyAt;
        assertEq(readyAt, vm.getBlockTimestamp() + p.vetoWindow);

        // Green: the reserve pays the merchant.
        uint256 assetsBefore = reserve.totalAssets();
        (KeelsonTypes.Verdict memory green, uint64 greenSize, bytes memory greenSigs) =
            _signed("verdict-green", _verdict(b, 30e6, KEELSON, "PP-D-green"));
        uint256 payeeBefore = pyusd.balanceOf(green.payee);
        vm.expectEmit(address(reserve));
        emit IKeelsonReserve.WarrantyPaid(green.disputeId, green.coverageId, green.payee, green.amount, _digest(green));
        reserve.payWarranty(green, greenSize, greenSigs);
        assertEq(pyusd.balanceOf(green.payee), payeeBefore + green.amount);
        assertEq(reserve.totalAssets(), assetsBefore - green.amount);

        // Release waits for the queued slash, then returns what was not slashed.
        vm.warp(uint256(vault.coverages(b.coverage.coverageId).releaseAfter) + 1);
        vm.expectRevert(IKeelsonBondVault.SlashPending.selector);
        vault.releaseCoverage(b.coverage.coverageId);
        vault.executeSlash(queued.disputeId);
        assertEq(_bond().slashCount, 2);
        uint128 freeBefore = _bond().free;
        vault.releaseCoverage(b.coverage.coverageId);
        vm.warp(uint256(vault.coverages(a.coverage.coverageId).releaseAfter) + 1);
        vault.releaseCoverage(a.coverage.coverageId);
        assertEq(_bond().free, freeBefore + b.coverage.amount - queued.amount + a.coverage.amount - amber.amount);
        assertEq(_bond().locked, 0);

        // I4.
        IKeelsonBondVault.Bond memory bond = _bond();
        assertLe(
            uint256(bond.free) + bond.locked + bond.queued + vault.claimable(merchant), pyusd.balanceOf(address(vault))
        );
    }
}
