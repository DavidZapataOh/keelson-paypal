// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployViolationBondPool} from "../script/DeployViolationBondPool.s.sol";
import {IPoolVault, ViolationBondPool} from "../src/ViolationBondPool.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";
import {IPYUSD} from "../src/interfaces/IPYUSD.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {ViolationBase} from "./utils/ViolationBase.sol";

/// @notice The operator's violation deposit pays the merchant of a coverage the real `MandateViolationCourt` convicted
/// with a real C2a proof, on a fork of Arbitrum Sepolia with real PYUSD, with no verdict and no TEE signature.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract ViolationBondPoolForkTest is ViolationBase {
    uint256 internal constant DEPOSIT = 200e6;

    ViolationBondPool internal pool;

    function setUp() public override {
        super.setUp();
        pool = new DeployViolationBondPool().run();
        _fundFromHolder(operator, DEPOSIT);
        vm.startPrank(operator);
        pyusd.approve(address(pool), DEPOSIT);
        pool.deposit(agentId, DEPOSIT);
        vm.stopPrank();
    }

    function test_conviction_paysTheMerchant() public {
        Case memory k = _convicted("category", court.CATEGORY_NOT_ALLOWED());
        vm.expectEmit(address(pool));
        emit ViolationBondPool.ViolationPaid(
            k.coverage.coverageId,
            agentId,
            address(court),
            merchant,
            k.coverage.amount,
            k.code,
            verdictVerifier.hashTypedData(KeelsonTypes.hash(k.countersign))
        );
        vm.prank(makeAddr("anyone"));
        pool.payViolation(address(court), k.coverage);
        assertEq(pyusd.balanceOf(merchant), k.coverage.amount);
        assertTrue(pool.paid(k.coverage.coverageId));
        assertEq(pool.deposits(agentId).balance, DEPOSIT - k.coverage.amount);
        _assertBackedPool();
    }

    function test_gas_payViolation() public {
        Case memory k = _convicted("merchant", court.MERCHANT_NOT_ALLOWED());
        pool.payViolation(address(court), k.coverage);
        uint256 gas = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("payViolation", gas);
        GasBudget.check("pool_payViolation", gas);
    }

    /// @dev A deposit short of the coverage pays nothing, so a token payout cannot stand in for the vault's slash.
    function test_shortDeposit_paysNothing() public {
        Case memory k = _convicted("amount", court.AMOUNT_OVER_MAX());
        _withdrawAllBut(k.coverage.amount - 1);
        vm.expectRevert(ViolationBondPool.NoDeposit.selector);
        pool.payViolation(address(court), k.coverage);
        assertFalse(pool.paid(k.coverage.coverageId));
    }

    function test_payout_goesToTheMerchantsPayoutAddress() public {
        address payout = makeAddr("merchant payout");
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(
            merchantKey,
            keccak256(
                abi.encodePacked(
                    "\x19\x01", vault.domainSeparator(), KeelsonTypes.hashPayoutAddress(merchant, payout, 0, deadline)
                )
            )
        );
        vault.setPayoutAddress(merchant, payout, 0, deadline, abi.encodePacked(r, s, sv));
        Case memory k = _convicted("currency", court.CURRENCY_MISMATCH());
        pool.payViolation(address(court), k.coverage);
        assertEq(pyusd.balanceOf(payout), k.coverage.amount);
        assertEq(pyusd.balanceOf(merchant), 0);
    }

    function test_payout_isOncePerCoverage() public {
        Case memory k = _convicted("category", court.CATEGORY_NOT_ALLOWED());
        pool.payViolation(address(court), k.coverage);
        vm.expectRevert(ViolationBondPool.AlreadyPaid.selector);
        pool.payViolation(address(court), k.coverage);
    }

    function test_noConviction_paysNothing() public {
        Case memory k = _lockedCase("category", court.CATEGORY_NOT_ALLOWED());
        vm.expectRevert(ViolationBondPool.NotConvicted.selector);
        pool.payViolation(address(court), k.coverage);
    }

    function test_unlistedCourt_paysNothing() public {
        Case memory k = _convicted("category", court.CATEGORY_NOT_ALLOWED());
        vm.expectRevert(ViolationBondPool.UnknownCourt.selector);
        pool.payViolation(makeAddr("a court of the operator's own"), k.coverage);
    }

    function test_alteredCoverage_paysNothing() public {
        Case memory k = _convicted("category", court.CATEGORY_NOT_ALLOWED());
        k.coverage.merchant = makeAddr("someone else");
        vm.expectRevert(ViolationBondPool.NotCovered.selector);
        pool.payViolation(address(court), k.coverage);
        k.coverage.merchant = merchant;
        k.coverage.amount += 1;
        vm.expectRevert(ViolationBondPool.NotCovered.selector);
        pool.payViolation(address(court), k.coverage);
    }

    function test_convictionAfterTheDisputeWindow_paysNothing() public {
        Case memory k = _lockedCase("category", court.CATEGORY_NOT_ALLOWED());
        vm.warp(vault.coverages(k.coverage.coverageId).releaseAfter + 1);
        court.proveViolation(k.coverage, k.countersign, k.hSd, k.countersigs, k.code, k.proof);
        vm.expectRevert(ViolationBondPool.ConvictedTooLate.selector);
        pool.payViolation(address(court), k.coverage);
    }

    function test_emptyDeposit_paysNothing() public {
        Case memory k = _convicted("category", court.CATEGORY_NOT_ALLOWED());
        _withdrawAllBut(0);
        vm.expectRevert(ViolationBondPool.NoDeposit.selector);
        pool.payViolation(address(court), k.coverage);
    }

    function test_withdrawal_waitsAndStaysPayable() public {
        Case memory k = _lockedCase("category", court.CATEGORY_NOT_ALLOWED());
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ViolationBondPool.NotAgentAuthority.selector);
        pool.requestWithdrawal(agentId, uint128(DEPOSIT), makeAddr("stranger"));

        address to = makeAddr("operator treasury");
        vm.prank(operator);
        pool.requestWithdrawal(agentId, uint128(DEPOSIT), to);
        uint256 unlockAt = vm.getBlockTimestamp() + pool.withdrawalDelay();
        vm.warp(unlockAt - 1);
        vm.expectRevert(ViolationBondPool.NotReady.selector);
        pool.completeWithdrawal(agentId);

        // A conviction while the request waits is paid from it.
        court.proveViolation(k.coverage, k.countersign, k.hSd, k.countersigs, k.code, k.proof);
        pool.payViolation(address(court), k.coverage);
        vm.warp(unlockAt);
        pool.completeWithdrawal(agentId);
        assertEq(pyusd.balanceOf(to), DEPOSIT - k.coverage.amount);
        assertEq(pool.deposits(agentId).balance, 0);
        _assertBackedPool();
    }

    function test_frozenRecipient_canClaimElsewhere() public {
        Case memory k = _convicted("category", court.CATEGORY_NOT_ALLOWED());
        _freeze(merchant);
        vm.expectEmit(address(pool));
        emit ViolationBondPool.PayoutFailed(k.coverage.coverageId, merchant, k.coverage.amount);
        pool.payViolation(address(court), k.coverage);
        assertEq(pool.claimable(merchant), k.coverage.amount);
        _assertBackedPool();
        address fresh = makeAddr("merchant fresh address");
        vm.prank(merchant);
        pool.claim(fresh);
        assertEq(pyusd.balanceOf(fresh), k.coverage.amount);
    }

    function test_delayNotAboveTheVaults_isRefused() public {
        address[] memory courts = new address[](0);
        uint40 vaultDelay = vault.params().withdrawalDelay;
        vm.expectRevert(ViolationBondPool.DelayTooShort.selector);
        new ViolationBondPool(
            IPYUSD(address(pyusd)),
            IPoolVault(address(vault)),
            IERC8004Identity(address(_identity())),
            address(this),
            vaultDelay,
            vaultDelay / 6,
            courts
        );
        vm.expectRevert(ViolationBondPool.InvalidWindow.selector);
        new ViolationBondPool(
            IPYUSD(address(pyusd)),
            IPoolVault(address(vault)),
            IERC8004Identity(address(_identity())),
            address(this),
            2 * vaultDelay,
            vaultDelay,
            courts
        );
    }

    function test_onlyTheAdminListsCourts() public {
        vm.expectRevert();
        pool.setCourt(makeAddr("court"), true);
    }

    /// @dev What the vault slashed is not paid again: the pool pays only what the coverage has left.
    function test_payout_isWhatTheVaultLeft() public {
        Case memory k = _convicted("category", court.CATEGORY_NOT_ALLOWED());
        _slash(_r00(k, 50e6, "PP-D-partial"));
        pool.payViolation(address(court), k.coverage);
        assertEq(pyusd.balanceOf(merchant), k.coverage.amount);
        assertEq(pool.deposits(agentId).balance, DEPOSIT - (k.coverage.amount - 50e6));

        Case memory full = _convicted("merchant", court.MERCHANT_NOT_ALLOWED());
        _slash(_r00(full, uint96(full.coverage.amount), "PP-D-full"));
        vm.expectRevert(ViolationBondPool.NothingLeft.selector);
        pool.payViolation(address(court), full.coverage);
    }

    function test_maturedRequest_lapsesAfterItsWindow() public {
        vm.prank(operator);
        pool.requestWithdrawal(agentId, uint128(DEPOSIT), operator);
        vm.warp(vm.getBlockTimestamp() + pool.withdrawalDelay() + pool.completionWindow() + 1);
        vm.expectRevert(ViolationBondPool.NotReady.selector);
        pool.completeWithdrawal(agentId);
    }

    function test_delistedCourt_paysOnlyWhatItConvictedBefore() public {
        Case memory before = _convicted("category", court.CATEGORY_NOT_ALLOWED());
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(address(_timelock()));
        pool.setCourt(address(court), false);
        assertFalse(pool.isCourt(address(court)));
        uint256 delistedAt = vm.getBlockTimestamp();
        Case memory later = _lockedCase("merchant", court.MERCHANT_NOT_ALLOWED());
        vm.warp(delistedAt + 1);
        court.proveViolation(later.coverage, later.countersign, later.hSd, later.countersigs, later.code, later.proof);
        vm.expectRevert(ViolationBondPool.NotConvicted.selector);
        pool.payViolation(address(court), later.coverage);
        pool.payViolation(address(court), before.coverage);
        assertEq(pyusd.balanceOf(merchant), before.coverage.amount);
    }

    function _r00(Case memory k, uint96 amount, string memory dispute)
        internal
        view
        returns (KeelsonTypes.Verdict memory)
    {
        return KeelsonTypes.Verdict({
            disputeId: keccak256(abi.encode(dispute, k.coverage.coverageId)),
            coverageId: k.coverage.coverageId,
            agentId: agentId,
            payee: merchant,
            amount: amount,
            ruleId: R00,
            liable: OPERATOR,
            fieldId: NO_FIELD,
            evidenceHash: bytes32(0),
            inputsHash: bytes32(0),
            policySetHash: k.countersign.policySetHash,
            checkpointRoot: checkpointRoot,
            issuedAt: uint40(vm.getBlockTimestamp()),
            deadline: uint40(vm.getBlockTimestamp() + 1 hours)
        });
    }

    function _convicted(string memory name, uint8 code) internal returns (Case memory k) {
        k = _lockedCase(name, code);
        court.proveViolation(k.coverage, k.countersign, k.hSd, k.countersigs, k.code, k.proof);
    }

    /// @dev Withdraws all of the deposit but `left`, through the delay.
    function _withdrawAllBut(uint256 left) internal {
        uint128 amount = pool.deposits(agentId).balance - uint128(left);
        uint40 started = uint40(vm.getBlockTimestamp());
        vm.prank(operator);
        pool.requestWithdrawal(agentId, amount, operator);
        vm.warp(started + pool.withdrawalDelay());
        pool.completeWithdrawal(agentId);
        vm.warp(started);
    }

    function _assertBackedPool() internal view {
        assertEq(
            pyusd.balanceOf(address(pool)),
            uint256(pool.deposits(agentId).balance) + pool.claimable(merchant),
            "pool backed"
        );
    }
}
